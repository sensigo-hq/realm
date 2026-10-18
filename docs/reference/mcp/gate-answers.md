# Gate answers over MCP

<!-- description: How Realm's MCP server handles the answer to a human gate: the asked, offered and withheld values, the form a chat app shows, present_question, what an answer records, and the separation check. -->

A human gate is a question a run asks a person. This page says who can answer it through Realm's MCP server, and how. Added after version 0.47.0.

## The three values

| Value      | What the agent gets                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `asked`    | The default. In an app that shows forms, the question goes to the person in the app's own form, and the agent gets no tool that records an answer. In an app without forms, the agent keeps the answer tool, and the app is asked to have the person approve each call. On an HTTP server built per request — `realm serve`, or a program that builds a server per request or passes `statelessHttp` — no client gets forms: under `asked` every client keeps the answer tool, marked for approval. A program that keeps one server per HTTP session sends forms as stdio does. |
| `offered`  | The answer tool, for any client of the server, the agent included.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `withheld` | No tool on the server records an answer, and its replies name no way to answer, except where a workflow's own text does: a gate's `agent_hint`, a gated step's `instructions` and `protocol.rules` are forwarded labelled as the author's, and warned about when the workflow is loaded; other step text and `quick_start` are forwarded as written.                                                                                                                                                                                                                            |

There are three ways to set the value: the `--gate-answers` flag of `realm mcp` and `realm serve`, the `REALM_MCP_GATE_ANSWERS` environment variable, and the `gateAnswers` option of `createRealmMcpServer`. When more than one is set, the most restrictive value wins: `withheld`, then `asked`, then `offered`. A value that is not one of the three stops the server from starting.

Set the value in your MCP client's own config, as an argument (`"args": ["mcp", "--gate-answers", "withheld"]`) or in its `env` block. A variable you export in a shell may not reach a server your client starts (the MCP SDK's client starts servers with a reduced environment).

`realm mcp` and `realm serve` print the value they run with when they start. Under `withheld` they also print how a person answers from a terminal: `realm run inspect <run_id>`, then `realm run respond <run_id> --gate <gate_id> --choice <choice>`.

Another Realm server or CLI that uses the same store can still record answers. The value holds only for the server it is given to.

## The form

Under `asked`, in an app that shows forms, the question is sent to the user's app as a form the first time `start_run`, `execute_step` or `advance_run` reaches it. The form has one field, "Your answer", whose options are the question's choices. Only an accepted form holding one of those choices records an answer. A declined, cancelled or failed form records nothing, and the question keeps waiting.

Realm waits for the form itself. The wait ends at the question's deadline when the gate declares `on_expiry`, or at the end of the call's own time: 240 seconds by default, counted from the start of the call. `--form-wait-seconds` (`REALM_MCP_FORM_WAIT_SECONDS`, the `formWaitSeconds` option) changes it, from 30 to 3600 seconds; when it is set in more than one place, the smallest value wins. The setting is refused at start wherever no form is sent: under `withheld` or `offered`, on `realm serve`, and with `statelessHttp`.

The tool `present_question` sends the form again. It is listed only in a session whose client shows forms, and it can send one question's form three more times in one server process.

The agent never gets an answer call for such a question. Its reply's `next_actions` entry has `awaiting` instead of `instruction`: the question's run, gate, step and choices, with words that say whether a form was sent in this session.

In an app without forms, the answer tool carries `_meta["anthropic/requiresUserInteraction"]`, which asks the app to have the person approve each call. Some apps ask the person, some skip it (Claude Code asked in interactive sessions and refused the call in headless runs when this page was written, October 2026); other apps may not ask. Realm cannot see whether anyone approved. A headless client that declares forms but cancels them leaves the question waiting: set `offered` for such a client.

## What an answer records

Each answer's entry in the run record says how it arrived:

| Field                     | What it holds                                                                                                                                   |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `answer`                  | `{ route, shown? }`: `mcp_form`, `mcp` or `cli`, as its door declared it; `{ absent: 'route_not_declared' }` from a program that declared none. |
| `driven_by`               | The program that recorded it.                                                                                                                   |
| `client_prompt_requested` | `true` when the app was asked to have the person approve the call.                                                                              |
| `principal`               | Who the server's transport authenticated: an API key's id, `realm serve`'s shared token (which names no one), or why there is none.             |

`realm run inspect` prints them on the answer's line, for example:

```text
Answer: approve · answered by (not stated) · through the user's app, as a form (as its door declared), recorded by mcp-stdio, running as ops@server-1 (from the OS user) · token: none passed (a token is passed only by Realm's MCP answer tool, from the conversation that opened the question, or by a program that calls the library with it)
```

An entry written by an earlier version reads `how it arrived was not recorded`.

## The separation check

`realm mcp --check` and `realm serve --check` print the value the server would start with and where it came from, then a separation check, and start no server; the only programs the check runs are the list and check modes of sudo, doas and polkit named below, and `getent` (on macOS, `dscl . -read /Users/<user> UserShell`), which looks users and groups up. Run it from the agent's own shell: it measures what that login can reach. With `HOME` set to the home of the user that runs Realm, it checks that user's store: a store this login cannot open is measured out of its reach, and one that is not found is not measured. The agent's own app settings are read from the login's own home, never from `HOME`.

Each condition prints as measured, as configured but not enforced by Realm, or as unknown with its cause; the two informational lines print as facts, marked (fact). The check says an agent cannot record a gate answer only when all of these hold: the store belongs to another user; this login cannot write or read the store, become that user without a password, reach an engine that runs containers or machines as root (Docker, LXD, Incus, Podman, libvirt or containerd), or be in a group that reaches one or the disks, or change the files Realm executes; and `--gate-answers withheld` is given on the `--check` line itself. The claim then names what the check cannot read: that no program Realm runs can run code for the agent, that Realm's server runs the Node binary and Realm package the check ran from, that every Realm server on the machine starts with `--gate-answers withheld`, and, when the store cannot be read, that no registered workflow's extension file can be changed by this login.

### Becoming Realm's user

The check never switches user, never asks for or tries a password, and never opens a login connection. It reads each way from this login to the user Realm runs as, and prints one entry per way, `way: reading (how it was read)`, measured now:

- **sudo.** Every root-owned copy named `sudo`, `sudo.ws` or `sudo-rs` in `/usr/bin`, `/usr/sbin`, `/usr/local/bin`, `/usr/local/sbin`, `/bin`, `/sbin`, `/run/wrappers/bin` or `/run/setuid-programs` is asked `sudo -V`, then `LC_ALL=C sudo -n -l`, and, when the original sudo lists its rules, `-n -ll`. A rule that runs as Realm's user or root without a password reads yes, whatever command it is limited to, and so does a `Defaults` line that may turn the password off for such a rule. A run-as name counts by its uid, so another name for root or for the user counts too. Rules listed although none of them waives the password read yes too: a cached credential, among other causes, lets them be listed. So do `exempt_group` naming a group this login may be in, and a listing shown under `listpw=all`. In the original sudo's listing, a rule that needs a password reads "needs" that password: this login's, or root's or the user's under `rootpw`, `targetpw` or `runaspw`. Where sudo shows no Defaults — sudo-rs's listings and either sudo's refusal — the password may be this login's, root's or the user's, and all three are read. The original sudo's "a password is required" reads "needs this login's password or is not allowed", because sudo does not say which; sudo-rs's "interactive authentication is required" needs this login's password, and its "Sorry, user … may not run sudo" reads not allowed. Whenever sudo needs a password, its PAM stacks are read too: `/etc/pam.d/sudo`, and `sudo-i` where it exists (or the services `pam_service` and `pam_login_service` name), with their includes. A security-key or fingerprint module adds "a person's touch or key"; an ssh-agent module, or a stack with no password or person module, reads unknown; a `pam_wheel.so trust` line for this login reads yes where a rule is listed or the sudo-rs refusal names one, and unknown where the original sudo refused.
- **su**, never run. On Linux, when `getent` cannot read the user's passwd entry, su reads unknown. When the user's shell runs no command (`/usr/sbin/nologin`, `/sbin/nologin`, `/bin/false` or `/usr/bin/false`) and no shells file lists it, su reads not allowed. An empty password field in the user's passwd entry reads yes. Otherwise su's PAM stacks, `su` and `su-l`, are read: a password module reads "needs" the user's password, and a `pam_wheel.so trust` line for this login reads yes. BusyBox's su, which reads no PAM stack, needs the user's password, whatever the user's shell: whether it keeps a shell that runs no command depends on how it was built.
- **doas.** Its rules in `/etc/doas.conf` and `/etc/doas.d/*.conf` are read, and doas is asked `doas -C <file> -u <user> <command>` for Realm's user and root — for each command a rule names (with one more argument too, unless the rule fixes its arguments) and for a command no rule names: `permit nopass` reads yes, `permit` needs this login's password, and `deny` reads not allowed.
- **polkit.** `pkcheck --action-id <action> --process <pid>` is asked, without `--allow-user-interaction`, for pkexec, for run0 and `systemd-run` (`org.freedesktop.systemd1.manage-units`), for machinectl's shells and for each program pkexec runs. polkit decides by session, and the check's session may not be the agent's, so each action's defaults count too. An answer that asks for a credential reads both this login's password and an administrator's, each kept for some minutes: polkit's rules may change whose it asks.
- **ssh.** It is listed when this login holds a key — any readable file in its own `.ssh` but a `.pub`, `known_hosts`, `config` or `authorized_keys`, or a set `SSH_AUTH_SOCK` — and an sshd is present. No connection is made.

A rule the check does not recognise, a file it cannot read, or a tool's error reads unknown, with the tool's own line, and then the stronger sentence is not printed. The tools are asked only as the root-owned copies in the folders above: a copy found only on PATH, or a system copy that is not root-owned or that this login can change, reads unknown; a copy elsewhere on PATH beside a good system copy is never run. A compromise that already holds root can fake any reading.

When every way needs a credential or is not allowed, the stronger sentence adds a condition for each thing no program can see from this login, and only for the ways it found:

- the agent cannot obtain a password a way needs (this login's, the user's, root's or an administrator's); for this login's and the user's, that it is not empty, since an empty one sits where this login cannot read it;
- nobody authenticates, as this login where the agent's processes run, those of sudo, doas and polkit whose password cache a way showed, because each then waives the password for some minutes;
- sudo turns off its password only through `NOPASSWD` tags, when the original sudo refused the listing, because its refusal hides `listpw` and the `Defaults!…` and `Defaults>…` lines;
- no polkit rule grants this login the entry points present (pkexec, run0, systemd-run or machinectl; polkit's actions when none is) beyond what the check's own session was shown, when polkit is present: the condition says which rules folder cannot be read here and which is not read;
- no person approves a Touch ID, fingerprint or security-key prompt the agent raises, when a way needs a person's touch or key;
- the user's `authorized_keys` holds none of this login's keys, when an sshd is present and this login holds a key.

Condition 3 connects to the sockets of Docker, LXD, Incus, Podman, libvirt and containerd — a socket this login can write counts even while its engine is stopped — and reads whether this login is in the group `disk`, `docker`, `lxd`, `incus-admin` or `libvirt`: membership outlasts a stopped daemon.

A refused sudo listing writes one syslog auth line naming the working folder (`sudo: <login> : a password is required ; PWD=… ; COMMAND=list`), and may leave an audit record where Linux auditd or macOS auditing runs. A listing that a still-valid ticket of the original sudo allowed renews that ticket. A socket connect may leave a log line on an engine that logs each connection. Nothing is locked, mailed or counted as a failed login while sudo's `noninteractive_auth` setting is off, as it is by default.

On Alpine, `/etc/doas.conf` (mode 0640) and `/etc/doas.d` (0750) cannot be read by other users, so doas reads unknown there. They hold rules, not secrets: `chmod 0644 /etc/doas.conf /etc/doas.d/*.conf` and `chmod 0755 /etc/doas.d` let the check read them.

On macOS, a sudo rule whose runas is a group, and a `pam_wheel` line, read unknown. Apple's sudo stack includes `sudo_local` and a smart-card module, which this check does not read, so sudo reads unknown on a Mac whenever it needs a password.
