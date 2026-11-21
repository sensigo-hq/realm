// docs-callback-c2c.test.ts — R1.3 callback C2c: the words this unit wrote for a person, each held to
// its page word for word (spaces folded, as a table's padding moves), with the cell that executes what
// it says named beside it: realm-listen.md's two flag rows and sections, its start steps, "The
// callback lines", its log-line and exit-code rows, and the CHANGELOG bullet. The four pins of the
// page's flag count and the K2c claims of the swept sentences live in their own files. Then the page's
// Flags table against `listenCommand`'s options, both ways: no other law compares them.
//
// Each assertion carries the two questions of `~/.claude/TESTING-RULES.md` rule 8 next to it.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { listenCommand } from './listen.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const LISTEN = 'docs/reference/cli/realm-listen.md';
const CHANGELOG = 'CHANGELOG.md';
const flat = (t: string): string => t.replace(/\s+/g, ' ');
const read = (page: string): string => readFileSync(join(ROOT, page), 'utf8');
/** (1) red when the page no longer holds the text word for word; (2) prints the text. */
function claim(page: string, text: string): void {
  expect(flat(read(page)), `${page} no longer says: ${text}`).toContain(flat(text));
}

describe('C2c — the words, each held to its page', () => {
  it('1. --callback-allow <entry>  None  A receiver a request may name as its c', () => {
    // Pinned by: listen-switch-c2c 'a real process: --callback-allow-private 10.0.0.5 and a key made first; a request for https://10.0.0.5/x registers; another host is not allowed'; the C2 door cells (callback_not_enabled without lists); C3 sends nothing yet: not built.
    claim(
      LISTEN,
      '| `--callback-allow <entry>` | None | A receiver a request may name as its callback address, in its `realm-callback-url` header, reached on a public address: a host name or an IP address, with a port if it is not 443 (`http://` before it for a receiver on plain http). Give it once per receiver. Without this flag or `--callback-allow-private`, every request that names a callback address is refused `callback_not_enabled`. This version registers the address with the run and does not yet send a callback. See [`--callback-allow`](#--callback-allow). Added after version 0.50.0. |',
    );
  });
  it('2. --callback-allow-private <entry>  None  As --callback-allow, for a rec', () => {
    // Pinned by: listen-switch-c2c 'a real process: --callback-allow-private 10.0.0.5 and a key made first; a request for https://10.0.0.5/x registers; another host is not allowed'; the C2 door cells (callback_not_enabled without lists); C3 sends nothing yet: not built.
    claim(
      LISTEN,
      '| `--callback-allow-private <entry>` | None | As `--callback-allow`, for a receiver that may also be on an address of this machine or of a private or shared network. Give it once per receiver. This version registers the address with the run and does not yet send a callback. See [`--callback-allow-private`](#--callback-allow-private). Added after version 0.50.0. |',
    );
  });
  it('3. Each --callback-allow <entry> names one receiver that a request may gi', () => {
    // Pinned by: listen-switch-c2c 'a real process: --callback-allow-private 10.0.0.5 and a key made first; a request for https://10.0.0.5/x registers; another host is not allowed'; allow-list.test (the entry forms); the C2 door cells; listen-switch-c2c 'two bad entries: the first, public list first; a repeated entry once; the two that can never work' (an IP entry refused at start); a host name taken as typed: executed by the reader, CB-C2C-RV-21 (no cell).
    claim(
      LISTEN,
      'Each `--callback-allow <entry>` names one receiver that a request may give as its callback address, in its `realm-callback-url` header. The entry is a host name or an IP address, with a port if it is not 443: `hooks.example.com`, `hooks.example.com:8443`, or `http://hooks.example.com:8080` for a receiver on plain http. An entry with `http://` allows `http` and `https` to that host and port; one without it allows `https` only. Upper and lower case name the same host. A callback address is allowed when its scheme, host and port match an entry. This flag is for receivers on public addresses: an entry that is an IP address of this machine or of a private or shared network is refused when `realm listen` starts, as below. A host name is taken as typed: this version does not check which address it leads to. Without this flag or `--callback-allow-private`, every request that names a callback address is refused `callback_not_enabled`. With either, `realm listen` reads its master key when it starts (see [The callback lines](#the-callback-lines)). This version registers the address with the run and does not yet send a callback. Added after version 0.50.0.',
    );
  });
  it('4. --callback-allow refuses a value that starts with -, except a lone -;', () => {
    // Pinned by: listen-switch-c2c 'the guard: a flag swallowed as an entry is refused, for both flags, and nothing starts'.
    claim(
      LISTEN,
      '`--callback-allow` refuses a value that starts with `-`, except a lone `-`; write `--callback-allow=value` for one.',
    );
  });
  it('5. An entry that is not one, or that can never be used, stops realm liste', () => {
    // Pinned by: listen-switch-c2c 'each of the nine refusal words, the exact line, exit 1, nothing before it; a typed password or token never echoed'; listen-switch-c2c 'two bad entries: the first, public list first; a repeated entry once; the two that can never work'; listen-switch-c2c 'an entry that begins with / or ?: no quote, by realm listen and by realm callback key (correction 1)'; start-lines-c2c (the quote rule).
    claim(
      LISTEN,
      'An entry that is not one, or that can never be used, stops `realm listen` before it reads any workflow, with exit code 1 and one line; the first refused entry is the only one said, the entries of `--callback-allow` before those of `--callback-allow-private`. The line quotes the entry only up to its first `/`, `?` or `#`, and not at all when it holds a user name or a password, or when it begins with `/`, `?` or `#`, so a token or a password typed into it is never printed:',
    );
  });
  it('6. The first line is for hooks.example.com/webhook; the last for an addre', () => {
    // Pinned by: listen-switch-c2c 'two bad entries: the first, public list first; a repeated entry once; the two that can never work'.
    claim(
      LISTEN,
      'The first line is for `hooks.example.com/webhook`; the last for an address that every flag refuses, such as the cloud metadata address. An entry given twice is kept once.',
    );
  });
  it('7. The same as --callback-allow, for a receiver that may also be on an ad', () => {
    // Pinned by: address.test (the classes, by value); listen-switch-c2c 'two bad entries: the first, public list first; a repeated entry once; the two that can never work'; allow-list.test (the same host in both lists counts as public).
    claim(
      LISTEN,
      'The same as `--callback-allow`, for a receiver that may also be on an address of this machine (`127.0.0.1`) or of a private or shared network (`10.0.0.5`, `192.168.1.20`, `100.64.0.1`). Some addresses are refused whichever flag lists them: the unspecified address, the cloud metadata address, and link-local, multicast, reserved and documentation addresses. A host and port given with both flags counts as given with `--callback-allow`. This version registers the address with the run and does not yet send a callback. Added after version 0.50.0.',
    );
  });
  it('8. --callback-allow-private refuses a value that starts with -, except a', () => {
    // Pinned by: listen-switch-c2c 'the guard: a flag swallowed as an entry is refused, for both flags, and nothing starts'.
    claim(
      LISTEN,
      '`--callback-allow-private` refuses a value that starts with `-`, except a lone `-`; write `--callback-allow-private=value` for one.',
    );
  });
  it('9. 2. Checks each --callback-allow and --callback-allow-private entry, an', () => {
    // Pinned by: listen-switch-c2c 'two bad entries: the first, public list first; a repeated entry once; the two that can never work'.
    claim(
      LISTEN,
      '2. Checks each `--callback-allow` and `--callback-allow-private` entry, and refuses to start at the first that is not one or can never be used (added after version 0.50.0).',
    );
  });
  it('10. 7. Starts listening, logs what the agents it starts ask each provider', () => {
    // Pinned by: listen-switch-c2c 'stale keys (one; six), a workflow without result_map that holds keys (not named), no workflow that takes callbacks, the order of the lines'.
    claim(
      LISTEN,
      '7. Starts listening, logs what the agents it starts ask each provider to cache (`listen: caching`, added after version 0.47.0), with an allow-list flag logs the callback lines (below, added after version 0.50.0), and logs the address.',
    );
  });
  it('11. With --callback-allow or --callback-allow-private, realm listen reads', () => {
    // Pinned by: listen-switch-c2c 'the same lines as the base (AU-01), and a master key command is not run; with a flag it runs once'; listen-switch-c2c 'no master key: no master line, and no key or master key in any line of any start above'.
    claim(
      LISTEN,
      'With `--callback-allow` or `--callback-allow-private`, `realm listen` reads its master key once (see [`realm callback`](realm-callback.md#where-the-master-key-comes-from)) and the stored callback keys once, when it starts. It logs what is on in lines that begin `listen: callbacks:`, after `listen: caching` and before the address line. Without either flag it logs none of them, reads no master key and runs no `REALM_ENCRYPTION_KEY_COMMAND`. No line shows a key, a master key or a callback URL. Added after version 0.50.0.',
    );
  });
  it('12. Here REALM_ENCRYPTION_KEY was set, the workflow refunds takes callback', () => {
    // Pinned by: executed on the build (reports/callback-c2c-the-switch.md, the page example).
    claim(
      LISTEN,
      'Here `REALM_ENCRYPTION_KEY` was set, the workflow `refunds` takes callbacks and `plain` does not. A key was made for `hooks.example.com` and for `old.example.com`, and none for `n8n.lan:5678`. The lines say, in order:',
    );
  });
  it('13. The allowed hosts, each with its port; (private) marks one given with', () => {
    // Pinned by: the the start lines, each from a real start cells of listen-switch-c2c.
    claim(
      LISTEN,
      'The allowed hosts, each with its port; `(private)` marks one given with `--callback-allow-private`. Then the mounted workflows that take callbacks (a workflow takes them when its trigger has a `result_map`). When none does, the line is a warning that every request that names a callback address is refused `callback_not_enabled`.',
    );
  });
  it('14. Which master key is in use, by its fingerprint, and where it came from', () => {
    // Pinned by: the the start lines, each from a real start cells of listen-switch-c2c.
    claim(
      LISTEN,
      'Which master key is in use, by its fingerprint, and where it came from: `REALM_ENCRYPTION_KEY`, the file `REALM_ENCRYPTION_KEY_FILE` names, `REALM_ENCRYPTION_KEY_COMMAND`, or `encryption.key in the Realm home`. With none, there is no such line. When it is `encryption.key` in the Realm home, a warning at every start reminds you to keep a copy of that file somewhere else. A setting that gives another key than `encryption.key`, or a key file other users can read, gets the warning `realm callback key` gives.',
    );
  });
  it('15. A source that is set but gives no key gets one warning, with its reaso', () => {
    // Pinned by: the the start lines, each from a real start cells of listen-switch-c2c.
    claim(
      LISTEN,
      'A source that is set but gives no key gets one warning, with its reason. `realm listen` starts anyway, says nothing about the keys, and refuses every allowed callback address `no_key` until the source is fixed.',
    );
  });
  it("16. For each workflow that takes callbacks and each allowed host: the key'", () => {
    // Pinned by: the the start lines, each from a real start cells of listen-switch-c2c.
    claim(
      LISTEN,
      "For each workflow that takes callbacks and each allowed host: the key's fingerprint, or, as a warning, what to do, ending with the `realm callback key` command that does it. A `realm listen` that has no master key and needs a key made is told to restart after making it: it reads its master key only when it starts.",
    );
  });
  it('17. For each workflow that takes callbacks, the hosts it keeps keys for th', () => {
    // Pinned by: the the start lines, each from a real start cells of listen-switch-c2c.
    claim(
      LISTEN,
      'For each workflow that takes callbacks, the hosts it keeps keys for that are not allowed, five at most and then how many more.',
    );
  });
  it("18. Stored keys that cannot be read get one warning with the store's error", () => {
    // Pinned by: the the start lines, each from a real start cells of listen-switch-c2c.
    claim(
      LISTEN,
      "Stored keys that cannot be read get one warning with the store's error, in place of the lines about the keys.",
    );
  });
  it('19. info  listen: callbacks: allowed hosts: <hosts>; workflows that take c', () => {
    // Pinned by: the the start lines, each from a real start cells of listen-switch-c2c; start-lines-c2c (the listing that throws).
    claim(
      LISTEN,
      '| `info` | `listen: callbacks: allowed hosts: <hosts>; workflows that take callbacks: <ids>` | At startup, with an allow-list flag (see [The callback lines](#the-callback-lines)). Added after version 0.50.0. |',
    );
  });
  it('20. warn  listen: callbacks: allowed hosts: <hosts>; no mounted workflow t', () => {
    // Pinned by: the the start lines, each from a real start cells of listen-switch-c2c; start-lines-c2c (the listing that throws).
    claim(
      LISTEN,
      '| `warn` | `listen: callbacks: allowed hosts: <hosts>; no mounted workflow takes callbacks (…), so every request that names a callback address is refused callback_not_enabled` | At startup, with an allow-list flag and no mounted workflow with `result_map`. Added after version 0.50.0. |',
    );
  });
  it('21. info  listen: callbacks: encryption key <fingerprint> from <source>  A', () => {
    // Pinned by: the the start lines, each from a real start cells of listen-switch-c2c; start-lines-c2c (the listing that throws).
    claim(
      LISTEN,
      '| `info` | `listen: callbacks: encryption key <fingerprint> from <source>` | At startup, with an allow-list flag and a master key. Added after version 0.50.0. |',
    );
  });
  it('22. warn  listen: callbacks: encryption.key in the Realm home is the maste', () => {
    // Pinned by: the the start lines, each from a real start cells of listen-switch-c2c; start-lines-c2c (the listing that throws).
    claim(
      LISTEN,
      '| `warn` | `listen: callbacks: encryption.key in the Realm home is the master key: keep a copy of it somewhere else; …` | At every startup with an allow-list flag whose master key comes from `encryption.key`. Added after version 0.50.0. |',
    );
  });
  it('23. warn  listen: callbacks: <setting> gives encryption key <fingerprint>,', () => {
    // Pinned by: the the start lines, each from a real start cells of listen-switch-c2c; start-lines-c2c (the listing that throws).
    claim(
      LISTEN,
      '| `warn` | `listen: callbacks: <setting> gives encryption key <fingerprint>, but <path> holds encryption key <fingerprint>.` | At startup: the setting and `encryption.key` hold different keys. Added after version 0.50.0. |',
    );
  });
  it('24. warn  listen: callbacks: <path> is open to other users (mode <mode>).', () => {
    // Pinned by: the the start lines, each from a real start cells of listen-switch-c2c; start-lines-c2c (the listing that throws).
    claim(
      LISTEN,
      "| `warn` | `listen: callbacks: <path> is open to other users (mode <mode>). Fix that with: chmod 600 <path>` | At startup: the master key's file can be read by others. Added after version 0.50.0. |",
    );
  });
  it('25. warn  listen: callbacks: <source> is not a master key: <reason>. … Eve', () => {
    // Pinned by: the the start lines, each from a real start cells of listen-switch-c2c; start-lines-c2c (the listing that throws).
    claim(
      LISTEN,
      '| `warn` | `listen: callbacks: <source> is not a master key: <reason>. … Every allowed host stays refused (no_key) until it is fixed.` | At startup: a master key source that is set gives no key (`REALM_ENCRYPTION_KEY_COMMAND did not give a master key: <reason>. …` for the command). Added after version 0.50.0. |',
    );
  });
  it('26. info  listen: callbacks: <workflow> → <host>: key <fingerprint>  At st', () => {
    // Pinned by: the the start lines, each from a real start cells of listen-switch-c2c; start-lines-c2c (the listing that throws).
    claim(
      LISTEN,
      '| `info` | `listen: callbacks: <workflow> → <host>: key <fingerprint>` | At startup: that workflow and host have a key it can read. Added after version 0.50.0. |',
    );
  });
  it('27. warn  listen: callbacks: <workflow> → <host>: <what to do>  At startup', () => {
    // Pinned by: the the start lines, each from a real start cells of listen-switch-c2c; start-lines-c2c (the listing that throws).
    claim(
      LISTEN,
      '| `warn` | `listen: callbacks: <workflow> → <host>: <what to do>` | At startup: no key, or one it cannot read; it ends with the `realm callback key` command. Added after version 0.50.0. |',
    );
  });
  it('28. info  listen: callbacks: <workflow>: a key is kept for <n> host(s) tha', () => {
    // Pinned by: the the start lines, each from a real start cells of listen-switch-c2c; start-lines-c2c (the listing that throws).
    claim(
      LISTEN,
      '| `info` | `listen: callbacks: <workflow>: a key is kept for <n> host(s) that are not allowed: <hosts>` | At startup: keys stored for hosts no flag allows. Added after version 0.50.0. |',
    );
  });
  it('29. warn  listen: callbacks: could not read the stored callback keys: <err', () => {
    // Pinned by: the the start lines, each from a real start cells of listen-switch-c2c; start-lines-c2c (the listing that throws).
    claim(
      LISTEN,
      '| `warn` | `listen: callbacks: could not read the stored callback keys: <error>` | At startup: the store could not list the keys. Added after version 0.50.0. |',
    );
  });
  it('30. An entry of --callback-allow or --callback-allow-private is not one (a', () => {
    // Pinned by: listen-switch-c2c 'the flags and their refusals'.
    claim(
      LISTEN,
      '| An entry of `--callback-allow` or `--callback-allow-private` is not one (added after version 0.50.0) | `Error: --callback-allow "hooks.example.com" is not an address Realm can allow: it has a path, query or fragment. Give a host name, with a port if it is not 443: hooks.example.com, or http://hooks.example.com:8080 for plain http.` |',
    );
  });
  it('31. A --callback-allow entry is an address only --callback-allow-private a', () => {
    // Pinned by: listen-switch-c2c 'the flags and their refusals'.
    claim(
      LISTEN,
      '| A `--callback-allow` entry is an address only `--callback-allow-private` allows (added after version 0.50.0) | `Error: --callback-allow "10.0.0.5" can never be used: it is a private, local or shared address, which this flag does not allow, so every callback to it would be refused (address). List it with --callback-allow-private only.` |',
    );
  });
  it('32. An entry is an address Realm never sends a callback to (added after ve', () => {
    // Pinned by: listen-switch-c2c 'the flags and their refusals'.
    claim(
      LISTEN,
      '| An entry is an address Realm never sends a callback to (added after version 0.50.0) | `Error: --callback-allow-private "169.254.169.254" can never be used: it is an address Realm never sends a callback to, whichever flag lists it, so every callback to it would be refused (address). Remove it.` |',
    );
  });
  it('33. --callback-allow or --callback-allow-private is followed by a flag in', () => {
    // Pinned by: listen-switch-c2c 'the flags and their refusals'.
    claim(
      LISTEN,
      "| `--callback-allow` or `--callback-allow-private` is followed by a flag in place of an entry (added after version 0.50.0) | `error: option '--callback-allow <entry>' argument is ambiguous: '--send-reminders' looks like a flag.` |",
    );
  });
  it('34. - realm listen takes the callback addresses you allow (R1.3). realm li', () => {
    // Pinned by: listen-switch-c2c 'the flags and their refusals'; the the start lines, each from a real start cells of listen-switch-c2c.
    claim(
      CHANGELOG,
      '- **`realm listen` takes the callback addresses you allow (R1.3).** `realm listen --callback-allow` and `realm listen --callback-allow-private` name the receivers a request may give as its callback address in its `realm-callback-url` header: the first for receivers on public addresses, the second for one that may also be on a private, local or shared address. Each entry is a host name, with a port if it is not 443 (`http://` before it for plain http); a bad entry, or an address that could never be used, stops `realm listen` at start with the reason. Without either flag every callback address is refused. At start it says which hosts are allowed, which master key is in use, and for each workflow and host whether its signing key can be read. This version registers the address with the run and does not yet send a callback. See [`realm listen`](docs/reference/cli/realm-listen.md).',
    );
  });
});

describe('C2c — the Flags table against the command', () => {
  it('every flag in the table is an option of realm listen, and every option is in the table', () => {
    const lines = read(LISTEN).split('\n');
    const head = lines.findIndex((l) => l.startsWith('## Flags'));
    const rows: string[] = [];
    for (let i = head; i < lines.length && !lines[i]!.startsWith('### '); i++) {
      if (lines[i]!.startsWith('| `--')) rows.push(lines[i]!.split('`')[1]!.split(' ')[0]!);
    }
    const options = listenCommand.options.map((o) => o.long!).sort();
    // (1) red when a flag is added to the command and not to the table, or the table names one the
    //     command does not have; (2) prints both lists.
    expect({ count: rows.length, table: [...rows].sort() }).toEqual({
      count: options.length,
      table: options,
    });
    expect(read(LISTEN)).toContain(
      `This page lists its argument and ${options.length} flags (13 in version 0.49.0),`,
    );
  });
});
