// webhook.ts — realm webhook command
// Receives GitHub webhook POST requests, verifies HMAC-SHA256 signatures,
// deduplicates deliveries by X-Github-Delivery ID, creates runs, and spawns
// realm agent as a detached child process for each new delivery.
import { createServer, type Server } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { spawn as nodeSpawn } from 'node:child_process';
import { join } from 'node:path';
import { Command } from 'commander';
import { loadWorkflowFromFile, JsonFileStore, JsonWorkflowStore } from '@sensigo/realm';
import type { WorkflowDefinition, WorkflowRegistrar, RunStore } from '@sensigo/realm';

const DEDUP_TTL_MS = 10 * 60 * 1000; // 10 minutes
const CACHE_MAX_SIZE = 1000;

/**
 * Checks a GitHub webhook HMAC-SHA256 signature using timing-safe comparison.
 * Returns true only if the header is present, uses the sha256= prefix, and
 * the HMAC matches byte-for-byte. Pads both buffers to equal length before
 * comparison to avoid length-based timing leaks.
 */
export function checkWebhookSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader?.startsWith('sha256=')) return false;
  const provided = signatureHeader.slice(7);
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  const maxLen = Math.max(a.length, b.length);
  const aa = Buffer.alloc(maxLen);
  const bb = Buffer.alloc(maxLen);
  a.copy(aa);
  b.copy(bb);
  // Compare in constant time AND require equal length — pads prevent length-leak
  // from short-circuiting timingSafeEqual, but lengths must still match for validity.
  return timingSafeEqual(aa, bb) && a.length === b.length;
}

/**
 * Checks whether a delivery ID is a duplicate within the TTL window.
 * Evicts stale entries and enforces a capacity cap on each call.
 * Returns true if the delivery was already seen; records it and returns false otherwise.
 */
export function isDuplicate(deliveryCache: Map<string, number>, deliveryId: string): boolean {
  const now = Date.now();
  // Evict stale entries on every request
  for (const [id, ts] of deliveryCache) {
    if (now - ts > DEDUP_TTL_MS) deliveryCache.delete(id);
  }
  // Enforce capacity cap — evict oldest entry when at limit
  if (deliveryCache.size >= CACHE_MAX_SIZE) {
    const oldest = [...deliveryCache.entries()].sort((a, b) => a[1] - b[1])[0]!;
    deliveryCache.delete(oldest[0]);
  }
  if (deliveryCache.has(deliveryId) && now - deliveryCache.get(deliveryId)! < DEDUP_TTL_MS) {
    return true;
  }
  deliveryCache.set(deliveryId, now);
  return false;
}

/** An event:action pair used to filter incoming webhook deliveries. */
export interface EventFilter {
  event: string;
  action: string;
}

/** Options for startWebhookServer — all I/O dependencies are injectable for testing. */
export interface StartWebhookServerOptions {
  port: number;
  secret: string;
  definition: WorkflowDefinition;
  events: EventFilter[];
  provider?: string;
  model?: string;
  /** Custom run store — avoids writing to disk in tests. */
  runStore?: RunStore;
  /** Custom workflow registrar — avoids writing to disk in tests. */
  workflowStore?: WorkflowRegistrar;
  /** Override spawn — injectable for test isolation. */
  spawnFn?: typeof nodeSpawn;
}

/**
 * Creates and starts the webhook HTTP server. Resolves once the server is listening.
 * The caller is responsible for calling server.close() when done.
 *
 * Security-first request handling order:
 * 1. Buffer body  2. Verify HMAC  3. Filter event/action  4. Dedup  5. Create run  6. Spawn agent
 */
export async function startWebhookServer(options: StartWebhookServerOptions): Promise<Server> {
  const runStore = options.runStore ?? new JsonFileStore();
  const workflowStore = options.workflowStore ?? new JsonWorkflowStore();
  const spawnFn = options.spawnFn ?? nodeSpawn;
  const deliveryCache = new Map<string, number>();

  const server = createServer(async (req, res) => {
    // 1. Buffer raw body before any other logic
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const rawBody = Buffer.concat(chunks);

    // 2. HMAC signature check — mandatory before any event filtering (oracle-attack prevention)
    const sigHeader = req.headers['x-hub-signature-256'] as string | undefined;
    if (!checkWebhookSignature(rawBody, sigHeader, options.secret)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid signature' }));
      return;
    }

    // 3. Parse JSON body
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawBody.toString('utf-8')) as Record<string, unknown>;
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    // 4. Check X-Github-Event header against configured event types
    const githubEvent = req.headers['x-github-event'] as string | undefined;
    const matchingEvents = options.events.filter((e) => e.event === githubEvent);
    if (matchingEvents.length === 0) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, skipped: 'event' }));
      return;
    }

    // 5. Check payload.action against configured action types
    const payloadAction = (payload as { action?: string }).action;
    const matchingActions = matchingEvents.filter((e) => e.action === payloadAction);
    if (matchingActions.length === 0) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, skipped: 'action' }));
      return;
    }

    // 6. Deduplication check — returns 200 to prevent GitHub retries on ignores
    const deliveryId = req.headers['x-github-delivery'] as string | undefined;
    if (deliveryId !== undefined && isDuplicate(deliveryCache, deliveryId)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, skipped: 'duplicate' }));
      return;
    }

    // 7. Extract params from payload using the standard PR event field mapping
    const pr = (payload as { pull_request?: Record<string, unknown> }).pull_request ?? {};
    const repo = (payload as { repository?: Record<string, unknown> }).repository ?? {};
    const sender = (payload as { sender?: Record<string, unknown> }).sender ?? {};
    const prBase = (pr as { base?: Record<string, unknown> }).base ?? {};
    const prHead = (pr as { head?: Record<string, unknown> }).head ?? {};
    const repoOwner = (repo as { owner?: Record<string, unknown> }).owner ?? {};
    const params: Record<string, unknown> = {
      pr_number: (pr as { number?: unknown }).number,
      pr_url: (pr as { html_url?: unknown }).html_url,
      repo: (repo as { full_name?: unknown }).full_name,
      repo_owner: (repoOwner as { login?: unknown }).login,
      repo_name: (repo as { name?: unknown }).name,
      pr_title: (pr as { title?: unknown }).title,
      base_sha: (prBase as { sha?: unknown }).sha,
      head_sha: (prHead as { sha?: unknown }).sha,
      author: (sender as { login?: unknown }).login,
      pr_action: payload['action'],
      github_delivery_id: deliveryId,
    };

    // 8. Register workflow definition with the store
    await workflowStore.register(options.definition);

    // 9. Create run record
    const run = await runStore.create({
      workflowId: options.definition.id,
      workflowVersion: options.definition.version,
      params,
    });

    // 10. Spawn realm agent as detached child — inherits full env (API keys, tokens, etc.)
    const realmBin = process.argv[1]!;
    const providerArgs: string[] = [];
    if (options.provider !== undefined) providerArgs.push('--provider', options.provider);
    if (options.model !== undefined) providerArgs.push('--model', options.model);

    const child = spawnFn(
      process.execPath,
      [realmBin, 'agent', '--run-id', run.id, ...providerArgs],
      { detached: true, stdio: 'inherit' },
    );
    child.unref();

    // 11. Log spawn event for visibility in server logs
    console.log(`realm agent spawned for run ${run.id} (pid: ${child.pid ?? 'unknown'})`);

    // 12. Respond 202 Accepted — run is created, agent is running in background
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, run_id: run.id }));
  });

  return new Promise((resolve, reject) => {
    let isListening = false;

    server.on('error', (err) => {
      if (!isListening) {
        reject(err);
      } else {
        console.error('Realm webhook server error:', err);
      }
    });

    server.listen(options.port, () => {
      isListening = true;
      resolve(server);
    });
  });
}

/**
 * `realm webhook` — starts an HTTP server that creates runs from GitHub webhook deliveries.
 * Verifies HMAC-SHA256 signatures, deduplicates deliveries, and spawns realm agent children.
 */
export const webhookCommand = new Command('webhook')
  .description('Start a webhook server that creates runs from GitHub events')
  .requiredOption('--workflow <path>', 'Path to workflow directory or workflow.yaml file')
  .requiredOption('--port <port>', 'Port to listen on')
  .option('--secret <secret>', 'GitHub webhook secret (overrides GITHUB_WEBHOOK_SECRET env var)')
  .option(
    '--event <filters>',
    'Comma-separated event:action pairs to handle',
    'pull_request:opened',
  )
  .option('--provider <provider>', 'LLM provider forwarded to spawned realm agent')
  .option('--model <model>', 'Model name forwarded to spawned realm agent')
  .action(
    async (opts: {
      workflow: string;
      port: string;
      secret?: string;
      event: string;
      provider?: string;
      model?: string;
    }) => {
      // Deprecation notice — `realm listen` supersedes `realm webhook` (GitHub flow maps via
      // a `trigger:` block with `auth: { mode: github }` + `params_map`).
      console.error(
        'Warning: `realm webhook` is deprecated and will be removed in a future release. ' +
          'Use `realm listen` with a `trigger:` block in your workflow (auth.mode: github) instead.',
      );

      // 1. Resolve secret — CLI flag overrides env var; refuse to start if neither set
      const secret = opts.secret ?? process.env['GITHUB_WEBHOOK_SECRET'];
      if (!secret) {
        console.error(
          'Error: webhook secret is required. Pass --secret or set GITHUB_WEBHOOK_SECRET.',
        );
        process.exit(1);
        return;
      }

      // 2. Load and validate workflow before binding the port
      const inputPath = opts.workflow;
      const filePath =
        inputPath.endsWith('.yaml') || inputPath.endsWith('.yml')
          ? inputPath
          : join(inputPath, 'workflow.yaml');

      let definition: WorkflowDefinition;
      try {
        definition = loadWorkflowFromFile(filePath);
      } catch (err) {
        console.error(
          `Error: failed to load workflow: ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exit(1);
        return;
      }

      // 3. Parse event filters from comma-separated event:action string
      const events: EventFilter[] = opts.event.split(',').map((token) => {
        const [event, action] = token.trim().split(':');
        return { event: event ?? '', action: action ?? '' };
      });

      // 4. Start server — only reached after secret and workflow are validated
      const port = parseInt(opts.port, 10);
      const server = await startWebhookServer({
        port,
        secret,
        definition,
        events,
        ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
        ...(opts.model !== undefined ? { model: opts.model } : {}),
      });

      const addr = server.address() as { port: number };
      console.log(`Realm webhook server listening on port ${addr.port}`);
    },
  );
