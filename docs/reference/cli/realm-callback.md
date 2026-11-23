# `realm callback`

<!-- description: Reference for realm callback key, which makes, prints, rotates, replaces and deletes the key a receiver checks a callback's signature with, and for the master key that seals these keys: its four sources, the file Realm makes, and how to keep it. -->

`realm callback` manages the key that a receiver, the program at the `--host` address (n8n, for example), checks a callback's signature with. It has one subcommand, [`key`](#key). `realm listen` signs every callback it sends with the key of that workflow and receiver (see [Receive a callback](../../guides/webhooks.md#receive-a-callback)); this page covers making and keeping the keys. This page was added after version 0.50.0.

A key belongs to one workflow and one receiver, a host and a port. Realm keeps it in `realm.db`, sealed (encrypted) under a master key that is kept outside that file: a copy of `realm.db` alone shows no key.

## `key`

`realm callback key [workflow] --host <entry> [--whsec] [--rotate [--keep-previous <hours>]] [--end-previous] [--replace] [--delete]`

Prints the key for one workflow and one receiver, and changes it. With no action flag it prints the key, and makes one first when there is none.

| Argument or flag          | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workflow`                | The workflow file, or the folder that holds its `workflow.yaml`. The default is the current folder. One workflow per run.                                                                                                                                                                                                                                                                                                                                                                                     |
| `--host <entry>`          | Required. The receiver: its host name or address, with a port if it is not 443 (80 after `http://`), as `n8n.example.com`, or `http://n8n.lan:5678` for a receiver on plain http; `https://` is refused. No path, no user name or password, no wildcard, and no address in brackets. Upper and lower case name the same host. The port is part of the key (`n8n.example.com:8443` is another key than `n8n.example.com`); the scheme is not (`http://n8n.lan:5678` and `n8n.lan:5678` are the same receiver). |
| `--whsec`                 | Prints the key as `whsec_` and the base64 of its text, the form some libraries expect.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `--rotate`                | Makes a new key and keeps the old one for `--keep-previous` hours. Refused while an earlier old key is still kept, unless `--end-previous` is also given; refused when there is no key, or the key cannot be read.                                                                                                                                                                                                                                                                                            |
| `--keep-previous <hours>` | With `--rotate` only: how long the old key is kept, a whole number from 1 to 168. The default is 24.                                                                                                                                                                                                                                                                                                                                                                                                          |
| `--end-previous`          | Ends the old key now. Alone, it changes nothing else; with `--rotate`, it lets the rotation replace an old key that is still kept.                                                                                                                                                                                                                                                                                                                                                                            |
| `--replace`               | Makes a new key where the stored one cannot be read: it was sealed under another master key, or is damaged. Refused for a key that can be read: use `--rotate`.                                                                                                                                                                                                                                                                                                                                               |
| `--delete`                | Removes the keys of that workflow and receiver.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

`--rotate`, `--replace` and `--delete` exclude each other. `--end-previous` cannot go with `--replace` or `--delete`, `--keep-previous` only with `--rotate`, and `--whsec` not with `--delete` or with `--end-previous` alone.

A key is made, printed, rotated or replaced only for a workflow that takes callbacks: its trigger has a `result_map` (see [Start runs from webhooks](../../guides/webhooks.md#getting-the-result-back)). `--end-previous` alone and `--delete` do not need that.

```bash
realm callback key ./my-workflow --host n8n.example.com
```

On success the key is the only thing on standard output: 64 lowercase hexadecimal characters and a line break (with `--whsec`, the `whsec_` form). Everything else goes to standard error, among it the key's short fingerprint and the fingerprint of the master key it is sealed under. The exit code is 0 when the command did what you asked, and also when there was nothing to do (no old key to end, no key to delete); it is 1 when the command refused. The line begins `Error:`, except a missing `--host` or a bad `--keep-previous`, which begin `error:`. A refusal about a key or the master key says "No key was changed." before what to do; one about the workflow file, the store file (a store that needs `realm db migrate`) or a combination of flags does not.

A fingerprint is the first 8 hexadecimal characters of a SHA-256 hash: it tells keys apart and shows neither. Realm's lines call the master key "encryption key". To check one yourself:

```text
printf '%s' <key> | sha256sum | cut -c1-8
xxd -r -p <master key file> | sha256sum | cut -c1-8
```

The first line is a key's fingerprint, the second a master key file's. (On macOS, where `sha256sum` is not installed, use `shasum -a 256`.)

Printing, making, rotating and replacing seal or open a key, so they need the master key. `--end-previous` alone and `--delete` never read it: a master key that is missing or wrong never stops you removing a key.

Running it again prints the same key. Two runs at the same moment, for the same workflow and receiver, end with the same key.

While the old key is kept after `--rotate`, `realm listen` signs each callback with both keys, the new key's signature first, so a receiver that has not yet been given the new key still checks it. Each try reads the keys afresh: a key made, rotated or ended here takes effect at the next try, with no restart.

```bash
realm callback key ./my-workflow --host n8n.example.com --rotate --keep-previous 48
```

A rotation keeps the old key in the store with an end time, and says when. `--end-previous` ends it sooner, and `--rotate` is refused while an old key is still kept unless you add `--end-previous`, so a working key is never dropped by accident. `--replace` is only for a key that cannot be read, for the same reason.

### When it refuses

| Situation                                          | What it means, and what to do                                                                                                                                                                                                                                                         |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The workflow takes no callbacks                    | Its trigger has no `result_map`. Add one, or leave the workflow alone: a key for it would never be used. A key made earlier is removed with `--delete`.                                                                                                                               |
| `--host` is not a receiver address                 | The line says which part: a path, a user name, a wildcard, brackets, a stray colon, a bad port, a scheme other than `http://`, no host, or an invalid host name.                                                                                                                      |
| The master key is not valid                        | The line names its source and why (not 64 hexadecimal characters, empty, a path that is not absolute, a file that cannot be read, or one of the command's failures). Realm does not go on to the next source.                                                                         |
| The key was sealed under another master key        | Set the master key it was sealed with, or use `--replace` to make a new key; the receiver then needs the new key. `--replace` is refused too while `encryption.key` holds a different key than your setting: move that file out of the home first, or make it match.                  |
| No master key here, but the store holds keys       | Realm lists the keys' master key fingerprints and refuses to make a second master key that could not read them. Set the master key they were sealed with. If it is lost, `--replace` for one of them makes a new master key file, and every other key then needs its own `--replace`. |
| A setting and `encryption.key` hold different keys | Printing a key that exists works, with a warning. Making, rotating and replacing are refused: a key written now would not be readable by a process that uses the file. Unset the setting or make the file match.                                                                      |
| `--rotate` while an old key is still kept          | Wait, or add `--end-previous`.                                                                                                                                                                                                                                                        |
| `--rotate` or `--replace` with no key              | Make one first, without those flags.                                                                                                                                                                                                                                                  |
| `--replace` on a key that can be read              | Use `--rotate`.                                                                                                                                                                                                                                                                       |
| The master key file cannot be made                 | The line gives the operating system's error code. Nothing was changed.                                                                                                                                                                                                                |

## Where the master key comes from

The master key is 64 hexadecimal characters (32 random bytes; `openssl rand -hex 32` makes one), never a passphrase. Realm takes it from the first of these that is set:

1. `REALM_ENCRYPTION_KEY`: the key itself.
2. `REALM_ENCRYPTION_KEY_FILE`: the absolute path of a file that holds the key and nothing else but an optional line break.
3. `REALM_ENCRYPTION_KEY_COMMAND`: a command that prints the key. See [The command source](#the-command-source).
4. The file `encryption.key` in the Realm home.

A value that is empty or only spaces counts as not set. A source that is set but gives no key is an error: Realm does not go on to the next one, and never makes a master key file then. `realm listen` reads it only when started with `--callback-allow` or `--callback-allow-private`; if it gives no key there, `realm listen` says so in a start line and starts without one, and every allowed callback address is then refused `no_key`.

When no source is set and the store holds no key, `realm callback key` makes `encryption.key` in the Realm home (`~/.realm`): 64 hexadecimal characters and a line break, readable by your account only (mode 600). It writes the file whole, so no other process reads half of it, and never over anything that is already at that name. It says so when it makes it. When no source is set but the store already holds keys, it refuses instead of making a second master key that could not read them.

On Linux and macOS, when the file the master key was read from can be read by other users, `realm callback key` prints a warning with the `chmod 600` line that fixes it. Secret files are often readable by others: Kubernetes mounts a Secret with mode 0644 unless you set `defaultMode`. When the output goes to a pipe, a path under your home folder prints as `[REDACTED]/…`; on a terminal it prints whole.

### The command source

`REALM_ENCRYPTION_KEY_COMMAND` names a command that prints the master key. Realm runs it directly and never through a shell: the value is split into words on spaces, tabs and line breaks, and a double quote keeps a word together (`op read "op://My Vault/realm key"` is three words). There are no escapes, and a single quote is an ordinary character. The first word is the program, looked up on the `PATH` of the environment Realm runs in: a service started with a short `PATH` needs the program's full path.

Realm gives the command the environment it runs in, whole (so `VAULT_ADDR` or `AWS_PROFILE` reach it) and no standard input, throws its error text away, waits at most 30 seconds, and reads at most 4,096 bytes of what it prints: a command that prints more is an error. The key is that text: 64 hexadecimal characters and an optional line break.

The command is an error, and Realm goes no further, when it exits with a status other than 0 or is ended by a signal, takes longer than 30 seconds, cannot be started, prints nothing or anything but the key, or has a value with an unclosed quote or no program. `realm listen` reads it only when started with `--callback-allow` or `--callback-allow-private`; if it gives no key there, `realm listen` says so in a start line and starts without one, and every allowed callback address is then refused `no_key`. A command that exits 0 but leaves a process running that holds its output counts as having taken too long. The line names the exit status, the signal, the error code or the reason in words; it never shows what the command printed, or its arguments.

Realm runs the command each time `realm callback key` looks for the key (not for `--delete` or `--end-previous`, nor when the arguments or the workflow are refused first), and every time `realm db check` opens a store file, whether or not it holds callback keys. `realm listen` runs it once, when it starts with `--callback-allow` or `--callback-allow-private`, and waits for it (up to 30 seconds) before it listens; without those flags it does not run it. A tool that asks for a password or a fingerprint asks each time, and each run can take up to 30 seconds. A `.env` file in the folder you run `realm` from can set `REALM_ENCRYPTION_KEY_COMMAND`, and Realm then runs what it names.

## Keeping the master key

`realm db backup` does not copy the master key: the copy has the keys, sealed, and not what opens them. Keep a copy of the master key somewhere safe, apart from your backups. If it is lost, or a store is restored on another machine without it, the stored keys cannot be read. Runs are not affected, only the keys: make each key again with `--replace` and give each receiver the new key. A `realm listen` that cannot read the key for a workflow and receiver sends none of the callbacks that key signs: it says so at start and once more when one is due, and they wait.

There is no command that seals the stored keys under a new master key. To keep the keys you have, put the same 64 characters in the new place (a file, a secret, a command's output) and set the setting that names it: nothing needs making again. To move to a new key, run `--delete` for each key (`realm db check` says how many are left), move `encryption.key` out of the home if it is there (while it holds a different key than your setting, Realm refuses to make or replace a key, and it never replaces the file itself), set the new master key, make each key again, and give each receiver the new key. Keep the old master key with the backups made before the move.

`realm listen` leaves the three settings out of the environment it gives each agent. A `.env` file in a workflow's folder is read by the agent itself and still reaches it.

## Recipes

These are examples with each tool's own commands: Realm's tests do not run them. Check each against your version of the tool. They show where the key can live; Realm reads it through `REALM_ENCRYPTION_KEY_FILE` or `REALM_ENCRYPTION_KEY_COMMAND`. The systemd, Compose and keychain recipes make a new master key; the secret-manager lines read one you stored there (`openssl rand -hex 32` makes it). If the Realm home already holds `encryption.key` and you have made keys, put that file's 64 characters in the new place instead, and move the file out of the home once the setting works. Set the same setting wherever you run `realm callback key` or `realm db check`; without it `realm callback key` makes a master key file of its own in the home, or refuses when the store already holds keys. The single quotes in the lines below belong to the shell; where a service file or a property list sets the variable, give the value without them.

**systemd credentials (Linux).** As root, seal the key for this machine, then load it into the service that will hold it; Realm reads it from the file the setting names:

```text
install -d -m 700 /etc/realm
key=$(openssl rand -hex 32)
printf '%s' "$key" | systemd-creds encrypt --name=realm-key - /etc/realm/realm-key.cred
printf '%s\n' "$key"
```

The last line prints the key once, so that you can keep a copy: the encrypted file opens only on this machine.

```ini
[Service]
LoadCredentialEncrypted=realm-key:/etc/realm/realm-key.cred
Environment=REALM_ENCRYPTION_KEY_FILE=%d/realm-key
```

`systemd-creds encrypt` needs the machine's key, which only root can read: as an ordinary user it fails.

**Docker Compose and Kubernetes secrets.** A secret arrives as a file. In Compose, add these lines to your own `realm` service:

```yaml
services:
  realm:
    environment:
      REALM_ENCRYPTION_KEY_FILE: /run/secrets/realm_master_key
    secrets:
      - realm_master_key
secrets:
  realm_master_key:
    file: ./realm-master-key.txt
```

Make the file with `openssl rand -hex 32 > realm-master-key.txt` and `chmod 600 realm-master-key.txt`. In Kubernetes, mount the Secret as a file, set `defaultMode: 0400` on the volume, and set `REALM_ENCRYPTION_KEY_FILE` to its path. The file must hold the key and nothing else.

**macOS keychain.** Keep the key in your login keychain and read it with a command:

```text
security add-generic-password -a "$USER" -s realm-master-key -w "$(openssl rand -hex 32)"
REALM_ENCRYPTION_KEY_COMMAND='security find-generic-password -s realm-master-key -w'
```

A launch daemon runs outside a user's login session. Apple's Technical Note TN3137 says such a program must use the file-based keychain, and lists the login keychain in the search list of a program that runs in a user's context. A command that reads the login keychain is for Realm run as that user's launch agent; for a launch daemon, keep the key in a file.

**A secret manager.** Realm links to none of them; each has a command that prints a value:

```text
REALM_ENCRYPTION_KEY_COMMAND='op read "op://Private/realm/master-key"'
REALM_ENCRYPTION_KEY_COMMAND='vault kv get -field=master_key secret/realm'
REALM_ENCRYPTION_KEY_COMMAND='aws secretsmanager get-secret-value --secret-id realm-master-key --query SecretString --output text'
REALM_ENCRYPTION_KEY_COMMAND='gcloud secrets versions access latest --secret=realm-master-key'
REALM_ENCRYPTION_KEY_COMMAND='az keyvault secret show --vault-name my-vault --name realm-master-key --query value --output tsv'
```

## See also

- [Environment variables and files on disk](../environment-and-files.md) lists the three settings and the files.
- [`realm db`](realm-db.md) covers `backup`, which does not copy the master key, and `check`, which counts the stored keys.
- [Start runs from webhooks](../../guides/webhooks.md#getting-the-result-back) covers `result_map`.
