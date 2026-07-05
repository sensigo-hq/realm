// realm serve — starts the Realm MCP server over HTTP for hosted agent platforms.
// Requires REALM_SERVE_TOKEN env var for Bearer token auth, or --dev for local development.
import { createServer, type Server } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { Command } from 'commander';
import { JsonWorkflowStore } from '@sensigo/realm';
import type { ExtensionRegistry, WorkflowDefinition } from '@sensigo/realm';
import { createRealmMcpServer } from '@sensigo/realm-mcp';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { makeRegistryProvider } from '../extensions/load-project-extensions.js';

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
}

/**
 * Creates and starts the HTTP MCP server. Resolves once the server is listening.
 * The caller is responsible for calling server.close() when done.
 *
 * Each HTTP request gets a fresh MCP server + stateless transport. The MCP SDK's
 * Protocol.connect() does not allow reconnecting a server to a new transport, so
 * per-request isolation is the correct pattern for stateless HTTP mode.
 */
export async function startHttpMcpServer(options: StartServerOptions): Promise<Server> {
  const { port, host, devMode, token, workflowStore, registryProvider } = options;

  // ONE workflow store per process (constructed at startup when none is injected).
  // JsonWorkflowStore.get() is readFileSync-per-call, so reusing the instance across
  // requests introduces zero staleness — re-registered workflows are picked up on the
  // next read.
  const store = workflowStore ?? new JsonWorkflowStore();

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
      // stable across requests.
      const mcpServer = createRealmMcpServer({
        workflowStore: store,
        ...(registryProvider !== undefined ? { registryProvider } : {}),
      });
      // Omitting sessionIdGenerator enables stateless mode (SDK default when absent).
      const transport = new StreamableHTTPServerTransport({});
      // @ts-expect-error — SDK type mismatch under exactOptionalPropertyTypes:
      // StreamableHTTPServerTransport.onclose is (() => void) | undefined but
      // Transport.onclose expects () => void. Runtime behaviour is correct.
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, parsedBody);
    } catch (err) {
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
  .action(async (options) => {
    const port = parseInt(options.port, 10);
    const host = options.host as string;
    const devMode = options.dev === true || process.env.REALM_DEV === '1';
    const token = process.env.REALM_SERVE_TOKEN;
    const registryProvider = makeRegistryProvider(
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

    const httpServer = await startHttpMcpServer({ port, host, devMode, token, registryProvider });
    console.log(`Realm MCP server listening on http://${host}:${port}/`);
    if (!devMode) {
      console.log('Authentication: Bearer token (REALM_SERVE_TOKEN)');
    }

    // Graceful shutdown on SIGINT / SIGTERM.
    const shutdown = () => httpServer.close(() => process.exit(0));
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
