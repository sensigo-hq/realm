// docs-callback-k2c.test.ts — callback K2c (R1.3; the owner's yeses 896326ed and eaa442b9): the words
// K2c writes for a person, each held to its page word for word (spaces folded, as a table's padding
// moves), with the cell that executes what it says named beside it (guardrail 9): the environment
// page's three variable rows and two file rows, realm-db.md's two paragraphs, realm-listen.md's
// sentence, core-library.md's two sentences, and the new page realm-callback.md row by row and
// paragraph by paragraph. The REALM_NOT_SECRET row and the count of variables are pinned in
// docs-disclosure-729.test.ts. Then (a) the new page's flags table against `callbackKeyCommand`, both
// ways, and (b) its links: its own anchors, its relative links, and the links into it from the
// environment page and realm-db.md.
//
// Each assertion carries the two questions of `~/.claude/TESTING-RULES.md` rule 8 next to it.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { callbackKeyCommand } from './callback-key.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const PAGE = 'docs/reference/cli/realm-callback.md';
const FILES = 'docs/reference/environment-and-files.md';
const DB = 'docs/reference/cli/realm-db.md';
const LISTEN = 'docs/reference/cli/realm-listen.md';
const CORE = 'docs/reference/core-library.md';
const flat = (t: string): string => t.replace(/\s+/g, ' ');
const read = (page: string): string => readFileSync(join(ROOT, page), 'utf8');
/** (1) red when the page no longer holds the text word for word; (2) prints the text. */
function claim(page: string, text: string): void {
  expect(flat(read(page)), `${page} no longer says: ${text}`).toContain(flat(text));
}

describe('callback K2c — environment-and-files.md: the three variable rows and the two file rows (E1)', () => {
  it('1. REALM_ENCRYPTION_KEY  realm callback key, realm db check  The master k', () => {
    // Pinned by: master-key-k1 '64 hex characters of either case, after one trailing newline; nothing else'; master-key-k1 'each source alone; with several set, the environment wins over the named file, which wins over the home file'; master-key-k1 'a set source that is invalid stops there, and an empty or all-whitespace environment value counts as unset'; listen-master-key-k1 'a log and an agent never see the master key’s value; the file’s path is a setting and is shown'; listen-master-key-k1 'neither the master key nor its file’s path reaches the agent; every other variable does, and listen keeps both'.
    claim(
      FILES,
      '| `REALM_ENCRYPTION_KEY` | `realm callback key`, `realm db check` | The master key the callback keys are sealed under: 64 hexadecimal characters, never a passphrase (`openssl rand -hex 32` makes one). It is the first source tried: when it is set, the file and the command below are not used. A value that is not 64 hexadecimal characters is an error, never a fall-through to another source. Realm hides its value in logs and does not pass it on to the agents `realm listen` starts. See [`realm callback`](cli/realm-callback.md#where-the-master-key-comes-from). Added after version 0.50.0. |',
    );
  });
  it('2. REALM_ENCRYPTION_KEY_FILE  realm callback key, realm db check  The abs', () => {
    // Pinned by: master-key-k1 'a zero-byte file and a file of one newline are empty; two newlines are malformed'; callback-key-k2a2 'the master key: each invalid source with its reason; nothing is replaced'; docs-disclosure-729 'realm's own settings, the shell's PWD, OLDPWD and _, and npm's three, are not treated as secrets; REALM_SERVE_TOKEN, REALM_ENCRYPTION_KEY and REALM_ENCRYPTION_KEY_COMMAND are (D-14, D-6)'; a path under HOME hidden in a log: CB-K2C-AU-10 (executed on the built core); listen-master-key-k1 'neither the master key nor its file’s path reaches the agent; every other variable does, and listen keeps both'; Docker, Kubernetes and systemd deliver secrets as files: not run, attributed (the recipes).
    claim(
      FILES,
      '| `REALM_ENCRYPTION_KEY_FILE` | `realm callback key`, `realm db check` | The absolute path of a file that holds the master key: 64 hexadecimal characters and, if you like, a line break, and nothing else. Read when `REALM_ENCRYPTION_KEY` is not set. A relative path, an empty file or a file that cannot be read is an error. Docker and Kubernetes secrets and systemd credentials arrive as files, so they fit here. Its value, a path, is not treated as a secret; a path under your home folder is still hidden in a log, as any such path is. Realm does not pass it on to the agents `realm listen` starts. See [`realm callback`](cli/realm-callback.md#recipes). Added after version 0.50.0. |',
    );
  });
  it('3. REALM_ENCRYPTION_KEY_COMMAND  realm callback key, realm db check  A co', () => {
    // Pinned by: master-key-command-k2b 'each adjacent pair: the setting over the file, the file over the command, the command over the home file'; master-key-command-k2b 'spaces, tabs, CR and LF separate; a double quote keeps a run together; no escapes'; master-key-command-k2b 'a command past the limit is a timeout: one that sleeps, one that ignores the polite stop, one that leaves a process holding its output'; master-key-command-cli-k2b 'a failing command never lets a key or a master key file be made: print, --rotate and --replace, with keys stored'; master-key-command-k2b 'a command’s output and error text are never kept: the key on stderr, or on stdout with exit 2'; listen-master-key-k1 'a log and an agent never see the command’s value: the sweep hides it whole'; listen-master-key-k1 'none of the three names reaches the agent; every other variable does'; the workflow folder's .env: CB-K2B-LB-04; the .env in the folder realm runs from: executed on the build in the K2c report (reports/docs-callback-k2c.md, "The page's examples, run").
    claim(
      FILES,
      "| `REALM_ENCRYPTION_KEY_COMMAND` | `realm callback key`, `realm db check` | A command that prints the master key. Read when neither `REALM_ENCRYPTION_KEY` nor `REALM_ENCRYPTION_KEY_FILE` is set. Realm runs it directly, with no shell: the words are split on spaces, and a double quote keeps a word together. It waits at most 30 seconds and reads 64 hexadecimal characters from what the command prints. A command that fails, takes too long or prints anything else is an error: Realm never falls back to another source, and never makes a master key file then. Its output and its error text are never shown. The value is hidden in logs, and `realm listen` does not pass it on to the agents it starts (a `.env` file in a workflow's folder still reaches them). A `.env` file in the folder you run `realm` from can set it, and Realm then runs what it names. See [`realm callback`](cli/realm-callback.md#the-command-source). Added after version 0.50.0. |",
    );
  });
  it('4. encryption.key  The master key the callback keys in realm.db are seale', () => {
    // Pinned by: master-key-file-k2a1 'absent: placed whole, owner-only, 64 lowercase hex and one newline, read back as found'; master-key-file-k2a1 'a regular file there: exists, its bytes unchanged, nothing left'; callback-key-k2a2 'print and make: the first run makes the master file and a key, the second prints the same key; --whsec'; callback-key-k2a2 'no master here and other keys stored: Words 4 (5 named, "and 1 more"), no file made; its advice works'; the backup copy: CB-K2A2-RV-17, and executed on the build in the K2c report (reports/docs-callback-k2c.md, "The page's examples, run").
    claim(
      FILES,
      '| `encryption.key` | The master key the callback keys in `realm.db` are sealed under: 64 hexadecimal characters and a line break, readable by your account only (mode 600). `realm callback key` makes it the first time it needs a master key, when no setting gives one and the store holds no key; it never makes one over a file that is already there. It is not in `realm.db` and `realm db backup` does not copy it: keep a copy somewhere safe, apart from your backups. | `realm callback key` |',
    );
  });
  it('5. .encryption.key-<pid>-<random>.tmp  The master key file being placed;', () => {
    // Pinned by: master-key-file-order-k2a1 'the temporary file is whole, owner-only and synced before it is linked'.
    claim(
      FILES,
      "| `.encryption.key-<pid>-<random>.tmp` | The master key file being placed; it exists for the length of one write. One left behind by a process that was killed holds the new master key's text (mode 600): delete it when no Realm process is running. | `realm callback key` |",
    );
  });
});

describe('callback K2c — realm-db.md: backup and check (E2)', () => {
  it('6. The copy holds the store and nothing else. It does not hold the master', () => {
    // Pinned by: CB-K2A2-RV-17 (the copy has no encryption.key, no master bytes, no key text); executed on the build in the K2c report (reports/docs-callback-k2c.md, "The page's examples, run").
    claim(
      DB,
      'The copy holds the store and nothing else. It does not hold the master key that seals the callback keys in it: not the file `encryption.key` in the Realm home, and not a key given in the environment. Without that key the callback keys in the copy cannot be read, so keep a copy of the master key apart from your backups. See [`realm callback`](realm-callback.md#keeping-the-master-key). Added after version 0.50.0.',
    );
  });
  it('7. When the store holds callback keys, it also says how many, and, when y', () => {
    // Pinned by: master-key-command-cli-k2b 'every stored slot counts; all under the shell’s master (B3a), some under another (B3b), the line last before the rule'; master-key-command-cli-k2b 'no master key in the shell, or a setting that gives none: B3c, exit 0, no master key error'; master-key-command-cli-k2b 'the command source: run once per check, B3a or B3b; a failing command prints B3c and exits 0'; store-check-keys-k2b 'the limit: a key damaged under the given fingerprint is not told apart from a good one'; the command with no keys stored: executed on the build in the K2c report (reports/docs-callback-k2c.md, "The page's examples, run").
    claim(
      DB,
      "When the store holds callback keys, it also says how many, and, when your shell has a master key, how many were recorded as sealed under another one: `Callback keys: 3 stored, 1 sealed under another master key than this shell's.` It prints no key. It compares the fingerprint of the master key recorded with each key, so it cannot tell a damaged key from a good one. It finds your master key the way `realm callback key` does, so a command in `REALM_ENCRYPTION_KEY_COMMAND` runs every time you run `db check` on a store file, whether or not the store holds callback keys. The count includes an old key that a rotation keeps. A shell with no usable master key gets `Callback keys: 3 stored; this shell has no usable master key, so none were compared.` and the exit code does not change. Added after version 0.50.0.",
    );
  });
});

describe('callback K2c — realm-listen.md: the environment an agent gets (E3)', () => {
  it('8. The new process has the environment of realm listen, except REALM_ENCR', () => {
    // Pinned by: listen-master-key-k1 'none of the three names reaches the agent; every other variable does'; the .env: CB-K2B-LB-04.
    claim(
      LISTEN,
      "The new process has the environment of `realm listen`, except `REALM_ENCRYPTION_KEY`, `REALM_ENCRYPTION_KEY_FILE` and `REALM_ENCRYPTION_KEY_COMMAND`, which Realm leaves out; it loads the `.env` file in the workflow's folder when it starts, and that file can set them. Leaving out those three settings was added after version 0.50.0.",
    );
  });
});

describe("callback K2c — core-library.md: the callbacks row's keys sentences (E4)", () => {
  it("9. read, make, rotate, endPrevious, replace and list each read the store'", () => {
    // Pinned by: store-sqlite callback-keys-list-k2a1 ('a home opened with no sealer lists every slot unreadable, with the row’s master key fingerprint', 'a pair whose only row is a previous at its end is not listed; a live one is'); the one clock reading: CB-K2A1-RV-05.
    claim(
      CORE,
      "`read`, `make`, `rotate`, `endPrevious`, `replace` and `list` each read the store's clock once; `delete` reads none. `list` answers every workflow and host that holds a live key, with each slot's fingerprint and never its text.",
    );
  });
  it("10. realm callback key uses keys; realm run purge reads a run's callbacks", () => {
    // Pinned by: CB-K2C-AU-16 (purge.ts reads a run's callbacks row; callback-key.ts is the only user of keys).
    claim(
      CORE,
      "`realm callback key` uses `keys`; `realm run purge` reads a run's `callbacks` row and removes it with the run. No other command uses the callback store yet.",
    );
  });
});

describe('callback K2c — realm-callback.md, the new page (E5)', () => {
  it('11. realm callback manages the key that a receiver, the program at the --h', () => {
    // Pinned by: callback-key-k2a2 'print and make: the first run makes the master file and a key, the second prints the same key; --whsec'; the request: not built yet (C2, C3); correction 1: CB-K2C-RV-17, RV-24 (no callback is sent yet).
    claim(
      PAGE,
      "`realm callback` manages the key that a receiver, the program at the `--host` address (n8n, for example), checks a callback's signature with. It has one subcommand, [`key`](#key). This version of Realm does not send a callback, so nothing is signed with these keys yet; this page covers only making and keeping them. The request is documented when Realm sends it. This page was added after version 0.50.0.",
    );
  });
  it('12. A key belongs to one workflow and one receiver, a host and a port. Rea', () => {
    // Pinned by: callback-key-k2a2 'flag checks in order, the first only; the nine entry words; --host missing; two spellings of one host'; sealed-home-k2a1 'a key made through openCliHome({ sealer }) reads readable; reopened with none, unreadable'; CB-K2A2-RV-17 (a copy shows no key).
    claim(
      PAGE,
      'A key belongs to one workflow and one receiver, a host and a port. Realm keeps it in `realm.db`, sealed (encrypted) under a master key that is kept outside that file: a copy of `realm.db` alone shows no key.',
    );
  });
  it('13. realm callback key [workflow] --host <entry> [--whsec] [--rotate [--ke', () => {
    // Pinned by: the help cell below.
    claim(
      PAGE,
      '`realm callback key [workflow] --host <entry> [--whsec] [--rotate [--keep <hours>]] [--end-previous] [--replace] [--delete]`',
    );
  });
  it('14. Prints the key for one workflow and one receiver, and changes it. With', () => {
    // Pinned by: callback-key-k2a2 'print and make: the first run makes the master file and a key, the second prints the same key; --whsec'.
    claim(
      PAGE,
      'Prints the key for one workflow and one receiver, and changes it. With no action flag it prints the key, and makes one first when there is none.',
    );
  });
  it('15. workflow  The workflow file, or the folder that holds its workflow.yam', () => {
    // Pinned by: callback-key-k2a2 'a workflow that cannot be loaded: Words 12, as realm listen says it; no home is made'; the folder form: executed on the build in the K2c report (reports/docs-callback-k2c.md, "The page's examples, run").
    claim(
      PAGE,
      '| `workflow` | The workflow file, or the folder that holds its `workflow.yaml`. The default is the current folder. One workflow per run. |',
    );
  });
  it('16. --host <entry>  Required. The receiver: its host name or address, with', () => {
    // Pinned by: allow-list 'the entry forms: the port is part of the entry (443, or 80 under http://); hosts as the parser normalises them'; allow-list 'each closed refusal word, one entry one word, in order'; callback-key-k2a2 'flag checks in order, the first only; the nine entry words; --host missing; two spellings of one host'; https:// refused, the scheme not part of the key: executed on the build in the K2c report (reports/docs-callback-k2c.md, "The page's examples, run").
    claim(
      PAGE,
      '| `--host <entry>` | Required. The receiver: its host name or address, with a port if it is not 443 (80 after `http://`), as `n8n.example.com`, or `http://n8n.lan:5678` for a receiver on plain http; `https://` is refused. No path, no user name or password, no wildcard, and no address in brackets. Upper and lower case name the same host. The port is part of the key (`n8n.example.com:8443` is another key than `n8n.example.com`); the scheme is not (`http://n8n.lan:5678` and `n8n.lan:5678` are the same receiver). |',
    );
  });
  it('17. --whsec  Prints the key as whsec_ and the base64 of its text, the form', () => {
    // Pinned by: callback-key-k2a2 'print and make: the first run makes the master file and a key, the second prints the same key; --whsec'.
    claim(
      PAGE,
      '| `--whsec` | Prints the key as `whsec_` and the base64 of its text, the form some libraries expect. |',
    );
  });
  it('18. --rotate  Makes a new key and keeps the old one for --keep hours. Refu', () => {
    // Pinned by: callback-key-k2a2 'rotate: a new key, the old kept 24 h (168 with --keep 168), refused while it is live, --end-previous ends it'; callback-key-k2a2 'rotate refusals: --keep out of range when the command line is read; --keep without --rotate; no key; an unreadable key'.
    claim(
      PAGE,
      '| `--rotate` | Makes a new key and keeps the old one for `--keep` hours. Refused while an earlier old key is still kept, unless `--end-previous` is also given; refused when there is no key, or the key cannot be read. |',
    );
  });
  it('19. --keep <hours>  With --rotate only: how long the old key is kept, a wh', () => {
    // Pinned by: callback-key-k2a2 'rotate refusals: --keep out of range when the command line is read; --keep without --rotate; no key; an unreadable key'; callback-key-k2a2 'rotate: a new key, the old kept 24 h (168 with --keep 168), refused while it is live, --end-previous ends it'.
    claim(
      PAGE,
      '| `--keep <hours>` | With `--rotate` only: how long the old key is kept, a whole number from 1 to 168. The default is 24. |',
    );
  });
  it('20. --end-previous  Ends the old key now. Alone, it changes nothing else;', () => {
    // Pinned by: callback-key-k2a2 'end and delete: idempotent, need no master key (even a broken one), make no master file, ignore opt-in'; callback-key-k2a2 'rotate: a new key, the old kept 24 h (168 with --keep 168), refused while it is live, --end-previous ends it'.
    claim(
      PAGE,
      '| `--end-previous` | Ends the old key now. Alone, it changes nothing else; with `--rotate`, it lets the rotation replace an old key that is still kept. |',
    );
  });
  it('21. --replace  Makes a new key where the stored one cannot be read: it was', () => {
    // Pinned by: callback-key-k2a2 'replace: refused on a readable key or none (no master file made); applied on a key of another master; with no master anywhere, makes the file first'.
    claim(
      PAGE,
      '| `--replace` | Makes a new key where the stored one cannot be read: it was sealed under another master key, or is damaged. Refused for a key that can be read: use `--rotate`. |',
    );
  });
  it('22. --delete  Removes the keys of that workflow and receiver.', () => {
    // Pinned by: callback-key-k2a2 'end and delete: idempotent, need no master key (even a broken one), make no master file, ignore opt-in'.
    claim(PAGE, '| `--delete` | Removes the keys of that workflow and receiver. |');
  });
  it('23. --rotate, --replace and --delete exclude each other. --end-previous ca', () => {
    // Pinned by: callback-key-k2a2 'flag checks in order, the first only; the nine entry words; --host missing; two spellings of one host'.
    claim(
      PAGE,
      '`--rotate`, `--replace` and `--delete` exclude each other. `--end-previous` cannot go with `--replace` or `--delete`, `--keep` only with `--rotate`, and `--whsec` not with `--delete` or with `--end-previous` alone.',
    );
  });
  it('24. A key is made, printed, rotated or replaced only for a workflow that t', () => {
    // Pinned by: callback-key-k2a2 'opt-in: a workflow with no result_map is refused by print, --rotate and --replace; nothing is made'; callback-key-k2a2 'end and delete: idempotent, need no master key (even a broken one), make no master file, ignore opt-in'.
    claim(
      PAGE,
      'A key is made, printed, rotated or replaced only for a workflow that takes callbacks: its trigger has a `result_map` (see [Start runs from webhooks](../../guides/webhooks.md#getting-the-result-back)). `--end-previous` alone and `--delete` do not need that.',
    );
  });
  it('25. On success the key is the only thing on standard output: 64 lowercase', () => {
    // Pinned by: callback-key-k2a2 'over every cell above: no master key in either case on any stream; a callback key only on stdout'; callback-key-k2a2 'end and delete: idempotent, need no master key (even a broken one), make no master file, ignore opt-in'; callback-key-k2a2 'flag checks in order, the first only; the nine entry words; --host missing; two spellings of one host'; callback-key-k2a2 'a workflow that cannot be loaded: Words 12, as realm listen says it; no home is made'; the store that needs realm db migrate: executed on the build in the K2c report (reports/docs-callback-k2c.md, "The page's examples, run"); correction 1: CB-K2C-RV-04 (the reader ran each refusal).
    claim(
      PAGE,
      'On success the key is the only thing on standard output: 64 lowercase hexadecimal characters and a line break (with `--whsec`, the `whsec_` form). Everything else goes to standard error, among it the key\'s short fingerprint and the fingerprint of the master key it is sealed under. The exit code is 0 when the command did what you asked, and also when there was nothing to do (no old key to end, no key to delete); it is 1 when the command refused. The line begins `Error:`, except a missing `--host` or a bad `--keep`, which begin `error:`. A refusal about a key or the master key says "No key was changed." before what to do; one about the workflow file, the store file (a store that needs `realm db migrate`) or a combination of flags does not.',
    );
  });
  it('26. A fingerprint is the first 8 hexadecimal characters of a SHA-256 hash:', () => {
    // Pinned by: callback-key-k2a2 'print and make: the first run makes the master file and a key, the second prints the same key; --whsec'; the two commands: executed on the build in the K2c report (reports/docs-callback-k2c.md, "The page's examples, run").
    claim(
      PAGE,
      'A fingerprint is the first 8 hexadecimal characters of a SHA-256 hash: it tells keys apart and shows neither. Realm\'s lines call the master key "encryption key". To check one yourself:',
    );
  });
  it("27. The first line is a key's fingerprint, the second a master key file's.", () => {
    // Pinned by: the two commands: executed on the build in the K2c report (reports/docs-callback-k2c.md, "The page's examples, run").
    claim(
      PAGE,
      "The first line is a key's fingerprint, the second a master key file's. (On macOS, where `sha256sum` is not installed, use `shasum -a 256`.)",
    );
  });
  it('28. Printing, making, rotating and replacing seal or open a key, so they n', () => {
    // Pinned by: callback-key-k2a2 'end and delete: idempotent, need no master key (even a broken one), make no master file, ignore opt-in'; master-key-command-cli-k2b '--end-previous and --delete never run the command'.
    claim(
      PAGE,
      'Printing, making, rotating and replacing seal or open a key, so they need the master key. `--end-previous` alone and `--delete` never read it: a master key that is missing or wrong never stops you removing a key.',
    );
  });
  it('29. Running it again prints the same key. Two runs at the same moment, for', () => {
    // Pinned by: callback-key-k2a2 'two processes on an empty home print the same key and leave one encryption.key'; callback-key-k2a2 'correction 1: four processes, one workflow and host, 20 rounds on fresh homes: one key each round, none says "no master key"'.
    claim(
      PAGE,
      'Running it again prints the same key. Two runs at the same moment, for the same workflow and receiver, end with the same key.',
    );
  });
  it('30. A rotation keeps the old key in the store with an end time, and says w', () => {
    // Pinned by: callback-key-k2a2 'rotate: a new key, the old kept 24 h (168 with --keep 168), refused while it is live, --end-previous ends it'; callback-key-k2a2 'replace: refused on a readable key or none (no master file made); applied on a key of another master; with no master anywhere, makes the file first'.
    claim(
      PAGE,
      'A rotation keeps the old key in the store with an end time, and says when. `--end-previous` ends it sooner, and `--rotate` is refused while an old key is still kept unless you add `--end-previous`, so a working key is never dropped by accident. `--replace` is only for a key that cannot be read, for the same reason.',
    );
  });
  it('31. The workflow takes no callbacks  Its trigger has no result_map. Add on', () => {
    // Pinned by: callback-key-k2a2 'opt-in: a workflow with no result_map is refused by print, --rotate and --replace; nothing is made'.
    claim(
      PAGE,
      '| The workflow takes no callbacks | Its trigger has no `result_map`. Add one, or leave the workflow alone: a key for it would never be used. A key made earlier is removed with `--delete`. |',
    );
  });
  it('32. --host is not a receiver address  The line says which part: a path, a', () => {
    // Pinned by: allow-list 'each closed refusal word, one entry one word, in order'; callback-key-k2a2 'flag checks in order, the first only; the nine entry words; --host missing; two spellings of one host'.
    claim(
      PAGE,
      '| `--host` is not a receiver address | The line says which part: a path, a user name, a wildcard, brackets, a stray colon, a bad port, a scheme other than `http://`, no host, or an invalid host name. |',
    );
  });
  it('33. The master key is not valid  The line names its source and why (not 64', () => {
    // Pinned by: callback-key-k2a2 'the master key: each invalid source with its reason; nothing is replaced'; master-key-command-cli-k2b 'seven of B1’s eight reasons, sentence for sentence: exit 1, nothing made, the token never printed'.
    claim(
      PAGE,
      "| The master key is not valid | The line names its source and why (not 64 hexadecimal characters, empty, a path that is not absolute, a file that cannot be read, or one of the command's failures). Realm does not go on to the next source. |",
    );
  });
  it('34. The key was sealed under another master key  Set the master key it was', () => {
    // Pinned by: callback-key-k2a2 'print on an unreadable key: another master (6c), no master here (6d), damaged under this one'; callback-key-k2a2 'replace: refused on a readable key or none (no master file made); applied on a key of another master; with no master anywhere, makes the file first'; callback-key-k2a2 'a setting and a different encryption.key: print warns (Words 9), make, rotate and replace refuse (Words 7)'.
    claim(
      PAGE,
      '| The key was sealed under another master key | Set the master key it was sealed with, or use `--replace` to make a new key; the receiver then needs the new key. `--replace` is refused too while `encryption.key` holds a different key than your setting: move that file out of the home first, or make it match. |',
    );
  });
  it("35. No master key here, but the store holds keys  Realm lists the keys' ma", () => {
    // Pinned by: callback-key-k2a2 'no master here and other keys stored: Words 4 (5 named, "and 1 more"), no file made; its advice works'.
    claim(
      PAGE,
      "| No master key here, but the store holds keys | Realm lists the keys' master key fingerprints and refuses to make a second master key that could not read them. Set the master key they were sealed with. If it is lost, `--replace` for one of them makes a new master key file, and every other key then needs its own `--replace`. |",
    );
  });
  it('36. A setting and encryption.key hold different keys  Printing a key that', () => {
    // Pinned by: callback-key-k2a2 'a setting and a different encryption.key: print warns (Words 9), make, rotate and replace refuse (Words 7)'; master-key-command-cli-k2b 'a command key and a different encryption.key: print warns (Words 9), make, rotate and replace refuse (Words 7), naming the command'.
    claim(
      PAGE,
      '| A setting and `encryption.key` hold different keys | Printing a key that exists works, with a warning. Making, rotating and replacing are refused: a key written now would not be readable by a process that uses the file. Unset the setting or make the file match. |',
    );
  });
  it('37. --rotate while an old key is still kept  Wait, or add --end-previous.', () => {
    // Pinned by: callback-key-k2a2 'rotate: a new key, the old kept 24 h (168 with --keep 168), refused while it is live, --end-previous ends it'.
    claim(PAGE, '| `--rotate` while an old key is still kept | Wait, or add `--end-previous`. |');
  });
  it('38. --rotate or --replace with no key  Make one first, without those flags', () => {
    // Pinned by: callback-key-k2a2 'rotate refusals: --keep out of range when the command line is read; --keep without --rotate; no key; an unreadable key'; callback-key-k2a2 'replace: refused on a readable key or none (no master file made); applied on a key of another master; with no master anywhere, makes the file first'.
    claim(PAGE, '| `--rotate` or `--replace` with no key | Make one first, without those flags. |');
  });
  it('39. --replace on a key that can be read  Use --rotate.', () => {
    // Pinned by: callback-key-k2a2 'replace: refused on a readable key or none (no master file made); applied on a key of another master; with no master anywhere, makes the file first'.
    claim(PAGE, '| `--replace` on a key that can be read | Use `--rotate`. |');
  });
  it('40. The master key file cannot be made  The line gives the operating syste', () => {
    // Pinned by: callback-key-seams-k2a2 'a refusal of the system is said with its code (Words 13); no key is made'.
    claim(
      PAGE,
      "| The master key file cannot be made | The line gives the operating system's error code. Nothing was changed. |",
    );
  });
  it('41. The master key is 64 hexadecimal characters (32 random bytes; openssl', () => {
    // Pinned by: master-key-k1 '64 hex characters of either case, after one trailing newline; nothing else'; master-key-command-k2b 'each adjacent pair: the setting over the file, the file over the command, the command over the home file'.
    claim(
      PAGE,
      'The master key is 64 hexadecimal characters (32 random bytes; `openssl rand -hex 32` makes one), never a passphrase. Realm takes it from the first of these that is set:',
    );
  });
  it('42. 1. REALM_ENCRYPTION_KEY: the key itself.', () => {
    // Pinned by: master-key-k1 'each source alone; with several set, the environment wins over the named file, which wins over the home file'.
    claim(PAGE, '1. `REALM_ENCRYPTION_KEY`: the key itself.');
  });
  it('43. 2. REALM_ENCRYPTION_KEY_FILE: the absolute path of a file that holds t', () => {
    // Pinned by: master-key-k1 'a zero-byte file and a file of one newline are empty; two newlines are malformed'; callback-key-k2a2 'the master key: each invalid source with its reason; nothing is replaced'.
    claim(
      PAGE,
      '2. `REALM_ENCRYPTION_KEY_FILE`: the absolute path of a file that holds the key and nothing else but an optional line break.',
    );
  });
  it('44. 3. REALM_ENCRYPTION_KEY_COMMAND: a command that prints the key. See [T', () => {
    // Pinned by: master-key-command-k2b 'each adjacent pair: the setting over the file, the file over the command, the command over the home file'.
    claim(
      PAGE,
      '3. `REALM_ENCRYPTION_KEY_COMMAND`: a command that prints the key. See [The command source](#the-command-source).',
    );
  });
  it('45. 4. The file encryption.key in the Realm home.', () => {
    // Pinned by: master-key-k1 'the home file: absent only when it has no entry; a dangling link is unreadable_file; a link to a key file is found'.
    claim(PAGE, '4. The file `encryption.key` in the Realm home.');
  });
  it('46. A value that is empty or only spaces counts as not set. A source that', () => {
    // Pinned by: master-key-k1 'a set source that is invalid stops there, and an empty or all-whitespace environment value counts as unset'; master-key-command-k2b 'a failing command with a valid home file is invalid, never found; a command key and another home file differ'; master-key-command-cli-k2b 'a failing command never lets a key or a master key file be made: print, --rotate and --replace, with keys stored'.
    claim(
      PAGE,
      'A value that is empty or only spaces counts as not set. A source that is set but gives no key is an error: Realm does not go on to the next one, and never makes a master key file then.',
    );
  });
  it('47. When no source is set and the store holds no key, realm callback key m', () => {
    // Pinned by: master-key-file-k2a1 'absent: placed whole, owner-only, 64 lowercase hex and one newline, read back as found'; master-key-file-k2a1 'a regular file there: exists, its bytes unchanged, nothing left'; master-key-file-order-k2a1 'the temporary file is whole, owner-only and synced before it is linked'; callback-key-k2a2 'print and make: the first run makes the master file and a key, the second prints the same key; --whsec'; callback-key-k2a2 'no master here and other keys stored: Words 4 (5 named, "and 1 more"), no file made; its advice works'.
    claim(
      PAGE,
      'When no source is set and the store holds no key, `realm callback key` makes `encryption.key` in the Realm home (`~/.realm`): 64 hexadecimal characters and a line break, readable by your account only (mode 600). It writes the file whole, so no other process reads half of it, and never over anything that is already at that name. It says so when it makes it. When no source is set but the store already holds keys, it refuses instead of making a second master key that could not read them.',
    );
  });
  it('48. On Linux and macOS, when the file the master key was read from can be', () => {
    // Pinned by: callback-key-k2a2 'a master key file open to others: Words 8 on print, make, rotate and replace'; the piped [REDACTED]/… path: the K2a-2 cells' `shown()`; on a terminal: executed on the build in the K2c report (reports/docs-callback-k2c.md, "The page's examples, run"); Kubernetes' default mode 0644: not run, attributed to Kubernetes' documentation.
    claim(
      PAGE,
      'On Linux and macOS, when the file the master key was read from can be read by other users, `realm callback key` prints a warning with the `chmod 600` line that fixes it. Secret files are often readable by others: Kubernetes mounts a Secret with mode 0644 unless you set `defaultMode`. When the output goes to a pipe, a path under your home folder prints as `[REDACTED]/…`; on a terminal it prints whole.',
    );
  });
  it('49. REALM_ENCRYPTION_KEY_COMMAND names a command that prints the master ke', () => {
    // Pinned by: master-key-command-k2b 'spaces, tabs, CR and LF separate; a double quote keeps a run together; no escapes'; master-key-command-k2b 'no shell: a ; and a $HOME are words the program gets, never a second command or an expansion'; the PATH lookup: CB-K2B-AU-03 (executed by the audit lane).
    claim(
      PAGE,
      '`REALM_ENCRYPTION_KEY_COMMAND` names a command that prints the master key. Realm runs it directly and never through a shell: the value is split into words on spaces, tabs and line breaks, and a double quote keeps a word together (`op read "op://My Vault/realm key"` is three words). There are no escapes, and a single quote is an ordinary character. The first word is the program, looked up on the `PATH` of the environment Realm runs in: a service started with a short `PATH` needs the program\'s full path.',
    );
  });
  it('50. Realm gives the command the environment it runs in, whole (so VAULT_AD', () => {
    // Pinned by: master-key-command-k2b 'the command sees the environment handed to the resolver; a quoted word with a space is one argument'; master-key-command-k2b 'a command’s output and error text are never kept: the key on stderr, or on stdout with exit 2'; master-key-command-k2b 'a command past the limit is a timeout: one that sleeps, one that ignores the polite stop, one that leaves a process holding its output'; master-key-command-k2b 'a key printed and exit 0 is found; CRLF too; 63 characters, nothing, or 10 KB is not'; no standard input: CB-MK-P-01; correction 1: CB-K2C-AU-08, RV-12 (the whole environment).
    claim(
      PAGE,
      'Realm gives the command the environment it runs in, whole (so `VAULT_ADDR` or `AWS_PROFILE` reach it) and no standard input, throws its error text away, waits at most 30 seconds, and reads at most 4,096 bytes of what it prints: a command that prints more is an error. The key is that text: 64 hexadecimal characters and an optional line break.',
    );
  });
  it('51. The command is an error, and Realm goes no further, when it exits with', () => {
    // Pinned by: master-key-command-k2b 'a failed command is invalid, even one that printed the right key; a signal, a missing or a non-executable program'; master-key-command-k2b 'a command past the limit is a timeout: one that sleeps, one that ignores the polite stop, one that leaves a process holding its output'; master-key-command-cli-k2b 'seven of B1’s eight reasons, sentence for sentence: exit 1, nothing made, the token never printed'.
    claim(
      PAGE,
      'The command is an error, and Realm goes no further, when it exits with a status other than 0 or is ended by a signal, takes longer than 30 seconds, cannot be started, prints nothing or anything but the key, or has a value with an unclosed quote or no program. A command that exits 0 but leaves a process running that holds its output counts as having taken too long. The line names the exit status, the signal, the error code or the reason in words; it never shows what the command printed, or its arguments.',
    );
  });
  it('52. Realm runs the command each time realm callback key looks for the key', () => {
    // Pinned by: master-key-command-cli-k2b 'print makes a key sealed under the command’s master and prints it again; the command runs once per invocation; no encryption.key'; master-key-command-cli-k2b '--end-previous and --delete never run the command'; master-key-command-cli-k2b 'the command source: run once per check, B3a or B3b; a failing command prints B3c and exits 0'; refused arguments or workflow first, no keys stored, and the .env in the folder realm runs from: executed on the build in the K2c report (reports/docs-callback-k2c.md, "The page's examples, run").
    claim(
      PAGE,
      'Realm runs the command each time `realm callback key` looks for the key (not for `--delete` or `--end-previous`, nor when the arguments or the workflow are refused first), and every time `realm db check` opens a store file, whether or not it holds callback keys. A tool that asks for a password or a fingerprint asks each time, and each run can take up to 30 seconds. A `.env` file in the folder you run `realm` from can set `REALM_ENCRYPTION_KEY_COMMAND`, and Realm then runs what it names.',
    );
  });
  it('53. realm db backup does not copy the master key: the copy has the keys, s', () => {
    // Pinned by: CB-K2A2-RV-17; executed on the build in the K2c report (reports/docs-callback-k2c.md, "The page's examples, run"); callback-key-k2a2 'replace: refused on a readable key or none (no master file made); applied on a key of another master; with no master anywhere, makes the file first'.
    claim(
      PAGE,
      '`realm db backup` does not copy the master key: the copy has the keys, sealed, and not what opens them. Keep a copy of the master key somewhere safe, apart from your backups. If it is lost, or a store is restored on another machine without it, the stored keys cannot be read. Runs are not affected, only the keys: make each key again with `--replace` and give each receiver the new key.',
    );
  });
  it('54. There is no command that seals the stored keys under a new master key.', () => {
    // Pinned by: the move to another master key: executed by the reader at review (delete, then make under another master); callback-key-k2a2 'a setting and a different encryption.key: print warns (Words 9), make, rotate and replace refuse (Words 7)'; master-key-file-k2a1 'a regular file there: exists, its bytes unchanged, nothing left'; correction 1: CB-K2C-RV-11, AU-05 (the order the reader ran).
    claim(
      PAGE,
      "There is no command that seals the stored keys under a new master key. To keep the keys you have, put the same 64 characters in the new place (a file, a secret, a command's output) and set the setting that names it: nothing needs making again. To move to a new key, run `--delete` for each key (`realm db check` says how many are left), move `encryption.key` out of the home if it is there (while it holds a different key than your setting, Realm refuses to make or replace a key, and it never replaces the file itself), set the new master key, make each key again, and give each receiver the new key. Keep the old master key with the backups made before the move.",
    );
  });
  it('55. realm listen leaves the three settings out of the environment it gives', () => {
    // Pinned by: listen-master-key-k1 'none of the three names reaches the agent; every other variable does'; the .env: CB-K2B-LB-04.
    claim(
      PAGE,
      "`realm listen` leaves the three settings out of the environment it gives each agent. A `.env` file in a workflow's folder is read by the agent itself and still reaches it.",
    );
  });
  it("56. These are examples with each tool's own commands: Realm's tests do not", () => {
    // Pinned by: not run: attributed (the page says so); correction 1: CB-K2C-RV-15 (a run without the shell, and one without the setting).
    claim(
      PAGE,
      "These are examples with each tool's own commands: Realm's tests do not run them. Check each against your version of the tool. They show where the key can live; Realm reads it through `REALM_ENCRYPTION_KEY_FILE` or `REALM_ENCRYPTION_KEY_COMMAND`. The systemd, Compose and keychain recipes make a new master key; the secret-manager lines read one you stored there (`openssl rand -hex 32` makes it). If the Realm home already holds `encryption.key` and you have made keys, put that file's 64 characters in the new place instead, and move the file out of the home once the setting works. Set the same setting wherever you run `realm callback key` or `realm db check`; without it `realm callback key` makes a master key file of its own in the home, or refuses when the store already holds keys. The single quotes in the lines below belong to the shell; where a service file or a property list sets the variable, give the value without them.",
    );
  });
  it('57. systemd credentials (Linux). As root, seal the key for this machine, t', () => {
    // Pinned by: not run: attributed; correction 1: CB-K2C-RV-18.
    claim(
      PAGE,
      '**systemd credentials (Linux).** As root, seal the key for this machine, then load it into the service that will hold it; Realm reads it from the file the setting names:',
    );
  });
  it('58. The last line prints the key once, so that you can keep a copy: the en', () => {
    // Pinned by: not run: attributed.
    claim(
      PAGE,
      'The last line prints the key once, so that you can keep a copy: the encrypted file opens only on this machine.',
    );
  });
  it("59. systemd-creds encrypt needs the machine's key, which only root can rea", () => {
    // Pinned by: CB-MK-P-03 (executed by MA 3: it fails as an ordinary user).
    claim(
      PAGE,
      "`systemd-creds encrypt` needs the machine's key, which only root can read: as an ordinary user it fails.",
    );
  });
  it('60. Docker Compose and Kubernetes secrets. A secret arrives as a file. In', () => {
    // Pinned by: not run: attributed; correction 1: CB-K2C-RV-19.
    claim(
      PAGE,
      '**Docker Compose and Kubernetes secrets.** A secret arrives as a file. In Compose, add these lines to your own `realm` service:',
    );
  });
  it('61. Make the file with openssl rand -hex 32 > realm-master-key.txt and chm', () => {
    // Pinned by: not run: attributed.
    claim(
      PAGE,
      'Make the file with `openssl rand -hex 32 > realm-master-key.txt` and `chmod 600 realm-master-key.txt`. In Kubernetes, mount the Secret as a file, set `defaultMode: 0400` on the volume, and set `REALM_ENCRYPTION_KEY_FILE` to its path. The file must hold the key and nothing else.',
    );
  });
  it('62. macOS keychain. Keep the key in your login keychain and read it with a', () => {
    // Pinned by: not run: attributed.
    claim(
      PAGE,
      '**macOS keychain.** Keep the key in your login keychain and read it with a command:',
    );
  });
  it("63. A launch daemon runs outside a user's login session. Apple's Technical", () => {
    // Pinned by: not run: attributed to Apple's Technical Note TN3137 (MK-32).
    claim(
      PAGE,
      "A launch daemon runs outside a user's login session. Apple's Technical Note TN3137 says such a program must use the file-based keychain, and lists the login keychain in the search list of a program that runs in a user's context. A command that reads the login keychain is for Realm run as that user's launch agent; for a launch daemon, keep the key in a file.",
    );
  });
  it('64. A secret manager. Realm links to none of them; each has a command that', () => {
    // Pinned by: not run: attributed.
    claim(
      PAGE,
      '**A secret manager.** Realm links to none of them; each has a command that prints a value:',
    );
  });
});

/** The anchor a heading gets: lower case, its marks dropped, its spaces as hyphens. */
function slug(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, '')
    .trim()
    .replace(/ /g, '-');
}
/** The anchors of a page's headings, code blocks skipped. */
function anchorsOf(page: string): Set<string> {
  const out = new Set<string>();
  let fence = false;
  for (const line of read(page).split('\n')) {
    if (line.startsWith('```')) fence = !fence;
    else if (!fence && /^#{1,6} /.test(line)) out.add(slug(line.replace(/^#+ /, '')));
  }
  return out;
}
/** The markdown links of a page, outside code blocks, as `target` strings. */
function linksOf(page: string): string[] {
  const text = read(page)
    .split(/^```[^\n]*\n[\s\S]*?^```$/m)
    .join('');
  return [...text.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]!);
}

describe('callback K2c — the new page against the command', () => {
  it('every flag and argument of the page’s flags table is the command’s, and every one of the command’s is in it', () => {
    const lines = read(PAGE).split('\n');
    const head = lines.findIndex((l) => l.startsWith('| Argument or flag'));
    const rows: string[] = [];
    for (let i = head + 2; i < lines.length && lines[i]!.startsWith('| '); i++)
      rows.push(lines[i]!);
    const named = rows.map((r) => r.split('`')[1]!.split(' ')[0]!).sort();
    const command = [
      ...callbackKeyCommand.options.map((o) => o.long!),
      ...callbackKeyCommand.registeredArguments.map((a) => a.name()),
    ].sort();
    // (1) red when a flag is added to the command and not to the page, or the page names one the
    //     command does not have (the refusals table is not read: its rows start with a situation);
    //     (2) prints both lists.
    expect({ rows: rows.length, named }).toEqual({ rows: command.length, named: command });
  });

  it('the page’s five anchors are its headings’, and every link on it, into it from the environment page and from realm-db.md resolves', () => {
    const own = anchorsOf(PAGE);
    const broken: string[] = [];
    const check = (from: string, target: string): void => {
      if (/^[a-z]+:/.test(target)) return;
      const [path, anchor] = target.split('#') as [string, string | undefined];
      const file = path === '' ? from : normalize(join(dirname(from), path));
      if (!existsSync(join(ROOT, file))) broken.push(`${from} → ${target}: no file`);
      else if (anchor !== undefined && !anchorsOf(file).has(anchor))
        broken.push(`${from} → ${target}: no heading`);
    };
    for (const target of linksOf(PAGE)) check(PAGE, target);
    const inbound = [FILES, DB].flatMap((from) =>
      linksOf(from)
        .filter((t) => t.includes('realm-callback.md'))
        .map((t) => [from, t] as const),
    );
    for (const [from, target] of inbound) check(from, target);
    // (1) red when a heading is renamed (its anchor goes), a link points at a file that moved, or an
    //     inbound link names an anchor the page does not have; (2) prints each broken link.
    expect({
      five: [
        'key',
        'where-the-master-key-comes-from',
        'the-command-source',
        'keeping-the-master-key',
        'recipes',
      ].filter((a) => !own.has(a)),
      inbound: inbound.length,
      broken,
    }).toEqual({ five: [], inbound: 5, broken: [] });
  });
});
