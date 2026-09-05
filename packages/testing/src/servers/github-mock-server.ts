// GitHubMockServer — local HTTP server that replays fixture-defined GitHub API responses.
import * as http from 'node:http';
import * as fs from 'node:fs';
import type { AddressInfo } from 'node:net';

/** A static fixture entry that returns a pre-defined body. */
interface StaticEntry {
  status: number;
  body: unknown;
}

/** An echo fixture entry that reflects selected fields from the request body. */
interface EchoEntry {
  status: number;
  echo: string[];
}

type FixtureEntry = StaticEntry | EchoEntry;

/**
 * Handle for a running GitHubMockServer instance.
 * Call `close()` in afterAll to release the port.
 */
export interface GitHubMockServerHandle {
  /** Base URL of the server, e.g. "http://localhost:49213" — the port ACTUALLY bound, not the
   *  requested one (the default is ephemeral). */
  url: string;
  /** Closes the server and resolves when fully shut down. */
  close(): Promise<void>;
}

/**
 * Matches a request method + URL path against a fixture key like "GET /repos/:owner/:repo/pulls/:pr".
 * `:param` segments match any non-empty, non-slash string.
 */
function matchRoute(method: string, urlPath: string, fixtureKey: string): boolean {
  const spaceIdx = fixtureKey.indexOf(' ');
  if (spaceIdx === -1) return false;
  const fixtureMethod = fixtureKey.slice(0, spaceIdx);
  const fixturePath = fixtureKey.slice(spaceIdx + 1);

  if (method !== fixtureMethod) return false;

  const urlSegments = urlPath.split('/');
  const fixtureSegments = fixturePath.split('/');

  if (urlSegments.length !== fixtureSegments.length) return false;

  for (let i = 0; i < fixtureSegments.length; i++) {
    const fSeg = fixtureSegments[i];
    const uSeg = urlSegments[i];
    if (fSeg === undefined || uSeg === undefined) return false;
    if (fSeg.startsWith(':')) {
      if (uSeg.length === 0) return false;
    } else if (fSeg !== uSeg) {
      return false;
    }
  }

  return true;
}

/**
 * Starts a local HTTP server that serves responses from a JSON fixture file.
 * Reads the fixture once at startup; does not re-read on each request.
 *
 * @param fixturePath - Absolute path to the fixture JSON file.
 * @param port - Port to bind to. Defaults to `0` (ephemeral, OS-assigned — hermetic: two
 *   concurrent checkouts/suites on the same box can never collide on a fixed port). Pass an
 *   explicit port to pin one; `url` is always derived from the port actually bound, so both
 *   forms behave identically from the caller's side.
 * @returns A handle with the server URL and a `close()` method.
 */
export async function startGitHubMockServer(
  fixturePath: string,
  port = 0,
): Promise<GitHubMockServerHandle> {
  const raw = fs.readFileSync(fixturePath, 'utf-8');
  const fixture = JSON.parse(raw) as Record<string, FixtureEntry>;

  const server = http.createServer((req, res) => {
    const method = req.method ?? 'GET';
    const rawUrl = req.url ?? '/';
    const urlPath = rawUrl.split('?')[0] ?? '/';

    let matchedKey: string | undefined;
    for (const key of Object.keys(fixture)) {
      if (matchRoute(method, urlPath, key)) {
        matchedKey = key;
        break;
      }
    }

    if (matchedKey === undefined) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'no matching fixture route' }));
      return;
    }

    const entry = fixture[matchedKey] as FixtureEntry;

    if ('echo' in entry) {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as Record<
            string,
            unknown
          >;
          const responseBody: Record<string, unknown> = {};
          for (const field of entry.echo) {
            responseBody[field] = body[field];
          }
          res.writeHead(entry.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(responseBody));
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid JSON body' }));
        }
      });
    } else {
      res.writeHead(entry.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(entry.body));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      reject(new Error(`GitHubMockServer: cannot bind to port ${port}: ${err.message}`));
    });
    server.listen(port, '127.0.0.1', () => resolve());
  });
  // Derive the URL from the port ACTUALLY bound, never the requested one: identical for an
  // explicit port, and the only correct source for the ephemeral default (the OS assigns the
  // real port at listen time — `server.address()` is where it becomes knowable).
  const boundPort = (server.address() as AddressInfo).port;

  return {
    url: `http://localhost:${boundPort}`,
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.close((err?: Error) => {
          if (err !== undefined) reject(err);
          else resolve();
        });
      });
    },
  };
}
