// listen-serve-values-944-docs.test.ts — issues #944 and #949 (guardrail 7(f), 9): each docs
// sentence and row this unit adds or rewrites on the `realm listen` and `realm serve` pages, and its
// CHANGELOG bullet, is quoted here word for word and asserted to be there; the old false texts are
// asserted gone. The behaviour each states is executed in the cells named beside it, in
// `listen-serve-values-944.test.ts` (through the built realm) and the parsers' and the bind line's
// value tables. Each assertion names (a) the change that turns it red and (b) what it prints when it
// fails: the page and the text. The help cell runs the built realm.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..', '..');
const CLI = join(HERE, '..', '..', 'dist', 'index.js');
const LISTEN = 'docs/reference/cli/realm-listen.md';
const SERVE = 'docs/reference/cli/realm-mcp-and-serve.md';
const flat = (t: string): string => t.replace(/\s+/g, ' ');
const read = (page: string): string => readFileSync(join(ROOT, page), 'utf8');
/** (a) red when the page no longer holds the text word for word; (b) prints the page and the text. */
function claim(page: string, text: string): void {
  expect(flat(read(page)), `${page} no longer says: ${text}`).toContain(flat(text));
}
/** (a) red when an old false text is back on the page; (b) prints the page and the text. */
function gone(page: string, text: string): void {
  expect(flat(read(page)), `${page} says again: ${text}`).not.toContain(flat(text));
}
/** #871's form: the section that holds this unit's entry — `[Unreleased]` until a release renames
 *  it, then the first release section above `[0.48.0]`, never a fixed heading. */
function claimChangelog(text: string): void {
  const all = read('CHANGELOG.md');
  const start = all.includes('## [Unreleased]')
    ? all.indexOf('## [Unreleased]')
    : all.indexOf('\n## [') + 1;
  const section = all.slice(start, all.indexOf('\n## [0.48.0]'));
  expect(flat(section), `the CHANGELOG no longer says: ${text}`).toContain(flat(text));
}

describe('issues #944, #949 — realm-listen.md', () => {
  it('the flag table: the five options say what they accept', () => {
    // Executed by option-parsers.test.ts (each parser's table) and the built-CLI cells "listen …:
    // one line from the parser" and "listen …: accepted, the server starts".
    claim(
      LISTEN,
      '| `--port <n>` | `3000` | The port to listen on: a whole number from 0 to 65535; 0 lets the system pick. |',
    );
    claim(
      LISTEN,
      '| `--host <addr>` | `127.0.0.1` | The address to listen on. The default accepts requests from the same machine only. An IP address or a host name. |',
    );
    claim(
      LISTEN,
      '| `--dedup-store <kind>` | `file` | Where the IDs of events already seen are kept: `file` or `memory`; any other word is refused. |',
    );
    claim(
      LISTEN,
      '| `--log-level <level>` | `info` | The least important level that is logged: `debug`, `info`, `warn` or `error`; any other word is refused. |',
    );
    claim(
      LISTEN,
      '| `--sweep-expired-gates <seconds>` | Off | Every this many seconds, carries out the gates in the store whose time has passed: a whole number of seconds from 1 to 2147483. |',
    );
  });

  it('"It does not start in these cases": the port-in-use row rewritten, eight rows added; the old row gone', () => {
    // Executed by "listen on a port in use: the EADDRINUSE line" and the old text's absence.
    claim(
      LISTEN,
      '| The port is in use (changed after version 0.48.0) | `Error: cannot listen on 127.0.0.1:4973: the port is already in use. Stop the program using it, or choose another --port.` |',
    );
    gone(
      LISTEN,
      '`Error: listen EADDRINUSE: address already in use 127.0.0.1:4973`, inside an error trace',
    );
    // Executed by the built-CLI refusal cells of `listen` (one per option and bad value class).
    claim(
      LISTEN,
      "| `--port` is not a whole number from 0 to 65535 (added after version 0.48.0) | `error: option '--port <n>' argument 'abc' is invalid. --port must be a whole number from 0 to 65535.` |",
    );
    claim(
      LISTEN,
      "| `--host` is empty, holds a space or starts with `-` (added after version 0.48.0) | `error: option '--host <addr>' argument 'a b' is invalid. --host must be an IP address or a host name.` |",
    );
    claim(
      LISTEN,
      "| `--dedup-store` is not `file` or `memory` (added after version 0.48.0) | `error: option '--dedup-store <kind>' argument 'mem' is invalid. --dedup-store must be file or memory.` |",
    );
    claim(
      LISTEN,
      "| `--log-level` is not `debug`, `info`, `warn` or `error` (added after version 0.48.0) | `error: option '--log-level <level>' argument 'bogus' is invalid. --log-level must be debug, info, warn or error.` |",
    );
    claim(
      LISTEN,
      "| `--sweep-expired-gates` is not a whole number from 1 to 2147483 (added after version 0.48.0) | `error: option '--sweep-expired-gates <seconds>' argument '0' is invalid. --sweep-expired-gates must be a whole number from 1 to 2147483.` |",
    );
    // Executed by "listen --port 80: the permission-denied line", "listen --host 192.0.2.1: …"
    // (both behind their probes) and "listen --host no-such-host.invalid: …".
    claim(
      LISTEN,
      '| The port needs rights `realm listen` does not have, or the system reserves it (added after version 0.48.0) | `Error: cannot listen on 127.0.0.1:80: permission denied. A port below 1024 usually needs extra rights, and on Windows the system can reserve a port. Choose another --port.` |',
    );
    claim(
      LISTEN,
      '| `--host` is not an address of this machine (added after version 0.48.0) | `Error: cannot listen on 192.0.2.1:3000: 192.0.2.1 is not an address of this machine. Check --host.` |',
    );
    claim(
      LISTEN,
      '| `--host` is a name that cannot be resolved (added after version 0.48.0) | `Error: cannot listen on no-such-host.invalid:3000: the name no-such-host.invalid cannot be resolved. Check --host.` |',
    );
  });

  it('the paragraph after the table: --host is checked for its shape only; the three false sentences gone', () => {
    // Executed by parseHost's table (what it accepts) and "listen --host no-such-host.invalid: …".
    claim(
      LISTEN,
      '`--host` is checked for its shape only: a name that is well formed but does not resolve fails when `realm listen` binds, with the last rows above.',
    );
    gone(LISTEN, 'The other flags are not checked.');
    gone(LISTEN, '`--dedup-store` with a value other than `memory` means `file`.');
    gone(LISTEN, '`--log-level` with an unknown value logs everything.');
  });
});

describe('issues #944, #949 — realm-mcp-and-serve.md', () => {
  it('the flag table: --port says what it accepts and that the start line prints the picked port; --host what it is', () => {
    // Executed by "serve --dev --port 0: the start line names the port the system picked" and the
    // serve refusal cells.
    claim(
      SERVE,
      '| `--port <number>` | `3001` | The port to listen on: a whole number from 0 to 65535; 0 lets the system pick, and the start line prints the port it picked. Added after version 0.48.0. |',
    );
    claim(
      SERVE,
      '| `--host <address>` | `127.0.0.1` | The address to listen on. The default accepts connections from the same machine only. An IP address or a host name. |',
    );
  });

  it('"It does not start in these cases": the port-in-use row rewritten, five rows added; the old row gone', () => {
    // Executed by "serve --dev on a port in use: the EADDRINUSE line" and the old text's absence.
    claim(
      SERVE,
      '| The port is in use (changed after version 0.48.0) | `Error: cannot listen on 127.0.0.1:3001: the port is already in use. Stop the program using it, or choose another --port.` |',
    );
    gone(
      SERVE,
      '`Error: listen EADDRINUSE: address already in use 127.0.0.1:3001`, inside an error trace',
    );
    // Executed by the serve refusal cells ("serve --dev …: one line from the parser").
    claim(
      SERVE,
      "| `--port` is not a whole number from 0 to 65535 (added after version 0.48.0) | `error: option '--port <number>' argument 'abc' is invalid. --port must be a whole number from 0 to 65535.` |",
    );
    claim(
      SERVE,
      "| `--host` is empty, holds a space or starts with `-` (added after version 0.48.0) | `error: option '--host <address>' argument 'a b' is invalid. --host must be an IP address or a host name.` |",
    );
    // Executed by "serve --dev --port 80: …", "serve --dev --host 192.0.2.1: …" (behind their
    // probes) and "serve --dev --host no-such-host.invalid: …".
    claim(
      SERVE,
      '| The port needs rights `realm serve` does not have, or the system reserves it (added after version 0.48.0) | `Error: cannot listen on 127.0.0.1:80: permission denied. A port below 1024 usually needs extra rights, and on Windows the system can reserve a port. Choose another --port.` |',
    );
    claim(
      SERVE,
      '| `--host` is not an address of this machine (added after version 0.48.0) | `Error: cannot listen on 192.0.2.1:3001: 192.0.2.1 is not an address of this machine. Check --host.` |',
    );
    claim(
      SERVE,
      '| `--host` is a name that cannot be resolved (added after version 0.48.0) | `Error: cannot listen on no-such-host.invalid:3001: the name no-such-host.invalid cannot be resolved. Check --host.` |',
    );
  });
});

describe('issues #944, #949 — the CHANGELOG bullet', () => {
  it('the refusals, the one-line bind failures, and serve --port 0 with an IPv6 host in brackets', () => {
    // Executed by the built-CLI refusal cells and the sweeper timing cell.
    claimChangelog(
      '**`realm listen` and `realm serve` refuse a bad option value when the command line is read, and say a failure to listen in one line (issues #944 and #949).** They refuse a bad `--port`, `--host`, `--dedup-store`, `--log-level` or `--sweep-expired-gates`. Before, a mistyped log level turned debug logging on, a mistyped dedup store selected the file store, a sweep interval of 0 or a word made the gate sweeper run about every millisecond, and a bad port or host ended in a stack trace.',
    );
    // Executed by the bind-failure cells (port in use, permission denied, not this machine's
    // address, a name that cannot be resolved).
    claimChangelog(
      "A failure to listen is one line naming the host and the port: a port in use, permission denied, an address that is not the machine's, a name that cannot be resolved.",
    );
    // Executed by "serve --dev --port 0: the start line names the port the system picked" and
    // serveStartLine's table.
    claimChangelog(
      '`realm serve --port 0` now prints the port the system picked in its start line (it printed `:0`), and the start line writes an IPv6 host in brackets (`http://[::1]:3001/`; it was `http://::1:3001/`, which is not a URL).',
    );
  });
});

describe('issues #944, #949 — the help texts', () => {
  // The help texts are claimed by no other cell. Commander wraps them to the terminal width, so the
  // output is compared with its whitespace collapsed. (a) red when a help text loses its range;
  // (b) prints the help output (the command's own text, no environment).
  it('realm listen --help and realm serve --help name the accepted ranges', () => {
    const home = mkdtempSync(join(tmpdir(), 'realm-944-help-'));
    try {
      const help = (args: string[]): string =>
        flat(
          spawnSync(process.execPath, [CLI, ...args], {
            cwd: home,
            env: { PATH: process.env['PATH'] ?? '', HOME: home },
            encoding: 'utf8',
            timeout: 20_000,
          }).stdout ?? '',
        );
      const listen = help(['listen', '--help']);
      const serve = help(['serve', '--help']);
      expect(
        {
          listenPort: listen.includes('a whole number from 0 to 65535; 0 lets the system pick'),
          listenSweep: listen.includes('a whole number of seconds from 1 to 2147483'),
          servePort: serve.includes('a whole number from 0 to 65535; 0 lets the system pick'),
        },
        JSON.stringify({ listen, serve }),
      ).toEqual({ listenPort: true, listenSweep: true, servePort: true });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);
});
