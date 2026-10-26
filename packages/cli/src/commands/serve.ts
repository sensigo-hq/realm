// realm serve — starts the Realm MCP server over HTTP for hosted agent platforms.
// Requires REALM_SERVE_TOKEN env var for Bearer token auth, or --dev for local development.
import { createServer, type Server } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { Command } from 'commander';
import { GATE_ANSWERS_VALUES, JsonWorkflowStore } from '@sensigo/realm';
import type {
  ExtensionRegistry,
  WorkflowDefinition,
  Attributed,
  PriceSource,
} from '@sensigo/realm';
import { createRealmMcpServer } from '@sensigo/realm-mcp';
import { cliOperatorRoute } from './ways-renderer.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { makeProjectProviders } from '../extensions/load-project-extensions.js';
import { resolveProgramIdentity } from '../lib/program-identity.js';
import { hostRefusalLine } from '../lib/host-refusal-line.js';
import { cliDisclosureProvider, writerCtx, writerInstalled } from '../output/writer.js';
import {
  checkValueLine,
  gateAnswersStartLine,
  readBinDoorSettings,
  DEV_MODE_ANSWER_WARNING,
} from '../lib/gate-answers-door.js';
import { measureSeparation, renderSeparation, systemProbes } from '../lib/separation-check.js';

const MAX_BODY_BYTES = 1 * 1024 * 1024; // 1 MiB

/**
 * Checks an Authorization header's Bearer token using timing-safe comparison.
 * Returns true only if the header is present, has the Bearer scheme, and the
 * token matches byte-for-byte. Prevents timing side-channel attacks.
 */
export function checkBearerToken(authHeader: string | undefined, expectedToken: string): boolean {
  if (!authHeader?.startsWith('Bearer ')) return false;
  const provided = authHeader.slice(7);
  const a = Buffer.from(provided);
  const b = Buffer.from(expectedToken);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export interface StartServerOptions {
  port: number;
  host: string;
  devMode: boolean;
  token: string | undefined;
  /** Custom workflow store — useful in tests to avoid writing to ~/.realm/. */
  workflowStore?: JsonWorkflowStore;
  /**
   * Per-definition registry resolution (project extensions). Backed by the process-lifetime
   * loader cache — module content changes require a server restart.
   */
  registryProvider?: (definition: WorkflowDefinition) => Promise<ExtensionRegistry>;
  /** Issue #600 caching PR P: per-definition prices for `get_run_state` (`makeProjectProviders`). */
  priceSourceProvider?: (definition: WorkflowDefinition) => Promise<PriceSource>;
  /**
   * Issue #625 (holder slice): the program this server runs as (channel `mcp-http`) — made ONCE at
   * startup and handed to every per-request MCP server. One shared bearer secret authenticates a
   * session, never a caller: this names the PROGRAM, as stated at startup.
   */
  driver?: Attributed;
  /** #627 W: the `--gate-answers` flag's value, passed to every per-request server (source `flag`). */
  gateAnswersFlag?: string;
}

/**
 * Creates and starts the HTTP MCP server. Resolves once the server is listening.
 * The caller is responsible for calling server.close() when done.
 *
 * Each HTTP request gets a fresh MCP server + stateless transport. The MCP SDK's
 * Protocol.connect() does not allow reconnecting a server to a new transport, so
 * per-request isolation is the correct pattern for stateless HTTP mode.
 *
 * issue #620 PR-C: one server is built with the same options BEFORE anything listens, so a
 * construction refusal (a store or registry from another realm) rejects the returned promise and
 * nothing listens — it would otherwise fail every request behind a `listening` line. That server
 * is discarded, never connected.
 */
export async function startHttpMcpServer(options: StartServerOptions): Promise<Server> {
  const {
    port,
    host,
    devMode,
    token,
    workflowStore,
    registryProvider,
    priceSourceProvider,
    driver,
    gateAnswersFlag,
  } = options;

  // ONE workflow store per process (constructed at startup when none is injected).
  // JsonWorkflowStore.get() is readFileSync-per-call, so reusing the instance across
  // requests introduces zero staleness — re-registered workflows are picked up on the
  // next read.
  const store = workflowStore ?? new JsonWorkflowStore();
  const serverOptions = {
    workflowStore: store,
    ...(registryProvider !== undefined ? { registryProvider } : {}),
    ...(priceSourceProvider !== undefined ? { priceSourceProvider } : {}),
    ...(driver !== undefined ? { driver } : {}),
    // #729 PR-0 (P-6): the CLI's renderer as the operator route — an operator's command reaches
    // only the block addressed to the person.
    operatorRoute: cliOperatorRoute('realm serve'),
    // #729 PR-3 (M-3): under the CLI's writer, every reply is masked with this process's set,
    // declared part included; embedded without it, the server's own default applies.
    ...(writerInstalled() ? { disclosureProvider: cliDisclosureProvider } : {}),
    // #627 W: one stateless request per server — it sends no forms, so `asked` is its fallback.
    statelessHttp: true,
    ...(gateAnswersFlag !== undefined ? { gateAnswersFlag } : {}),
    // #627 W (§5.8): the principal this door authenticates — the shared token names no one; dev mode
    // authenticates nothing. Stamped by the door on every answer it records.
    principal: devMode
      ? ({ absent: 'door_authentication_disabled' } as const)
      : ({ kind: 'shared_token' } as const),
  };
  // The startup construction: a throw here rejects this async function's promise.
  createRealmMcpServer(serverOptions);

  const httpServer = createServer(async (req, res) => {
    // Auth gate — evaluated before any MCP logic.
    if (!devMode) {
      if (!checkBearerToken(req.headers['authorization'], token!)) {
        res.writeHead(401, {
          'WWW-Authenticate': 'Bearer',
          'Content-Type': 'application/json',
        });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
    }

    try {
      // Collect the request body before handing off to the transport.
      let totalBytes = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        totalBytes += (chunk as Buffer).length;
        if (totalBytes > MAX_BODY_BYTES) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Request body too large' }));
          req.destroy();
          return;
        }
        chunks.push(chunk as Buffer);
      }
      const rawBody = Buffer.concat(chunks).toString('utf-8');

      let parsedBody: unknown;
      if (rawBody.length > 0) {
        try {
          parsedBody = JSON.parse(rawBody);
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON in request body' }));
          return;
        }
      }

      // The per-request MCP server shares the process-lifetime workflow store and
      // registryProvider — extension registries (and their rate-limiter buckets) stay
      // stable across requests. An error while a request is handled is logged below (a registry
      // a tool resolves per call is checked inside that tool, which answers with the refusal).
      const mcpServer = createRealmMcpServer(serverOptions);
      // Omitting sessionIdGenerator enables stateless mode (SDK default when absent).
      const transport = new StreamableHTTPServerTransport({});
      // @ts-expect-error — SDK type mismatch under exactOptionalPropertyTypes:
      // StreamableHTTPServerTransport.onclose is (() => void) | undefined but
      // Transport.onclose expects () => void. Runtime behaviour is correct.
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, parsedBody);
    } catch (err) {
      // issue #620 PR-C: the reason a request failed is logged — a store or registry refused at
      // the hand-off would otherwise be a bare 500 with the cause nowhere.
      console.error(hostRefusalLine('serve', err));
      if (!res.headersSent && !res.destroyed) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error' }));
      } else {
        res.destroy(err instanceof Error ? err : new Error(String(err)));
      }
    }
  });

  return new Promise((resolve, reject) => {
    let isListening = false;

    httpServer.on('error', (err) => {
      if (!isListening) {
        reject(err);
      } else {
        console.error('Realm MCP server error:', err);
        httpServer.close(() => process.exit(1));
      }
    });

    httpServer.listen(port, host, () => {
      isListening = true;
      resolve(httpServer);
    });
  });
}

/** A Node `listen` failure (`EADDRINUSE`, `EACCES`): read inside a `try`, so it is total. */
function isListenFailure(err: unknown): boolean {
  try {
    return (err as { syscall?: unknown } | null)?.syscall === 'listen';
  } catch {
    return false;
  }
}

/**
 * `realm serve` — starts the Realm MCP server over HTTP.
 * Designed for hosted agent platforms (OpenClaw, Claude.ai, custom backends) that
 * cannot spawn a local stdio subprocess.
 */
export const serveCommand = new Command('serve')
  .description(
    'Start the Realm MCP server over HTTP (for hosted agent platforms that cannot use stdio)',
  )
  .option('--port <number>', 'Port to listen on', '3001')
  .option('--host <address>', 'Bind address', '127.0.0.1')
  .option('--dev', 'Disable authentication (for local development only)')
  .option(
    '--extensions-module <path>',
    "CODE override: module that REPLACES every workflow's declared 'extensions' modules (repair tool)",
  )
  .option(
    '--project <dir>',
    'CONFIG anchor: deployment root whose realm.yaml applies to definitions without a stored trust_root (default: current directory — serve is operator-launched)',
  )
  .option(
    '--gate-answers <value>',
    'How this server handles gate answers: asked (the default), offered or withheld. The most restrictive of this flag and REALM_MCP_GATE_ANSWERS wins.',
  )
  .option(
    '--form-wait-seconds <seconds>',
    'Refused here: this server sends no forms (accepted by realm mcp)',
  )
  .option(
    '--check',
    'Print the gate-answers value this server would start with and the separation check, then exit without starting',
  )
  .action(async (options) => {
    // #627 W (§5.1): the settings, read as the server will read them; a bad value, or a form wait on
    // this door that sends no forms (W-s9), refuses the start before anything is bound.
    const settings = readBinDoorSettings(
      'serve',
      {
        gateAnswers: options.gateAnswers as string | undefined,
        formWaitSeconds: options.formWaitSeconds as string | undefined,
      },
      process.env,
    );
    if (!settings.ok) {
      console.error(settings.line);
      process.exit(1);
    }
    if (options.check === true) {
      // W-s6 and the separation check (Part K): nothing is started.
      console.log(
        checkValueLine(settings.answers, (v) => writerCtx().word(v, GATE_ANSWERS_VALUES)),
      );
      const evidence = await measureSeparation({
        probes: systemProbes(),
        value: { value: settings.answers.value, source: settings.answers.source },
        roots: [(options.project as string | undefined) ?? process.cwd()],
        // Correction 1 (D3, D5): the code file this command line names, and this door.
        extensionsModule: options.extensionsModule as string | undefined,
        door: 'serve',
      });
      console.log(renderSeparation(evidence, writerCtx()).join('\n'));
      process.exit(0);
    }
    // issue #625 (holder slice): this program's name, made once outside the per-request handler,
    // before anything is bound. A name that cannot be used prints one line and exits 1.
    const driver = resolveProgramIdentity('mcp-http');
    const port = parseInt(options.port, 10);
    const host = options.host as string;
    const devMode = options.dev === true || process.env.REALM_DEV === '1';
    const token = process.env.REALM_SERVE_TOKEN;
    // issue #600 caching PR P: the registry and the prices share one load per definition call.
    const { registryProvider, priceSourceProvider } = makeProjectProviders(
      options.extensionsModule as string | undefined,
      (options.project as string | undefined) ?? process.cwd(),
    );

    if (!devMode && !token) {
      console.error(
        'Error: REALM_SERVE_TOKEN is not set.\n' +
          'Set it to a secret token, or use --dev / REALM_DEV=1 for local development only.',
      );
      process.exit(1);
    }

    if (devMode) {
      console.warn(
        'Warning: Running in dev mode — authentication is disabled. ' +
          'Do not expose this to a network.',
      );
    }

    // issue #620 PR-C: a server that cannot be built is one line on stderr and exit 1 — never a
    // `listening` line over a server that fails every request (a release-line refusal there means
    // this command's own install is split: `hostRefusalLine` says so). A failure to listen (the
    // port in use) is not a construction refusal and propagates as before.
    let httpServer: Server;
    try {
      httpServer = await startHttpMcpServer({
        port,
        host,
        devMode,
        token,
        registryProvider,
        priceSourceProvider,
        ...(driver !== undefined ? { driver } : {}),
        ...(options.gateAnswers !== undefined
          ? { gateAnswersFlag: options.gateAnswers as string }
          : {}),
      });
    } catch (err) {
      if (isListenFailure(err)) throw err;
      console.error(hostRefusalLine('serve', err));
      process.exit(1);
    }
    console.log(`Realm MCP server listening on http://${host}:${port}/`);
    if (!devMode) {
      console.log('Authentication: Bearer token (REALM_SERVE_TOKEN)');
    }
    // #627 W: the start line (stdout on this door), and W-s5 when dev mode leaves an answer tool open.
    console.log(gateAnswersStartLine(settings.answers, true));
    if (devMode && settings.answers.value !== 'withheld') console.warn(DEV_MODE_ANSWER_WARNING);

    // Graceful shutdown on SIGINT / SIGTERM.
    const shutdown = () => httpServer.close(() => process.exit(0));
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
