# Give an agent step tools

<!-- description: Give an agent step tools from a tool server, limit how much it may use them, and read what Realm records about each call. -->

An agent step can look things up before it answers: read a file, query an API, search a ticket system. This guide gives a step two tools from a tool server, limits how much it may use them, and shows what Realm records about each call. At the end you have a step that answers a question from a folder of notes.

## Before you start

You need:

- A workflow with an agent step. [Write an agent step](agent-steps.md) makes one.
- `realm agent` set up to drive it. See [Run a workflow with `realm agent`](realm-agent.md).
- `npx`, which comes with Node.js, to start the example tool server.

**The tools on this page are offered only when `realm agent` drives the step.** An assistant connected over MCP is given the step's prompt and nothing about its tools. It uses whatever tools it has itself, and Realm does not record those calls.

## How it works

A **tool server** is a program that offers tools over MCP, the same protocol assistants use to call Realm. The workflow names the servers it uses, and each agent step lists the tools it may call. When `realm agent` reaches the step, it starts the server, tells the model about the listed tools, carries out each call the model asks for, and records it.

## 1. Name the tool server

Add an `mcp_servers` block at the top level of the workflow. This one starts a public server that reads files in one folder:

```yaml
mcp_servers:
  - id: notes
    transport: stdio
    command: npx
    args: ['-y', '@modelcontextprotocol/server-filesystem', './notes']
```

| Key         | Meaning                                                                                                            |
| ----------- | ------------------------------------------------------------------------------------------------------------------ |
| `id`        | The name steps use for this server.                                                                                |
| `transport` | How Realm talks to it. `stdio` is the only value: Realm starts the program and talks over its input and output.    |
| `command`   | The program to start.                                                                                              |
| `args`      | Its arguments.                                                                                                     |
| `env`       | Environment variables for it. A value such as `'${NOTES_TOKEN}'` is filled from the shell that runs `realm agent`. |

Create the folder and one note for the server to read:

```bash
mkdir notes
printf '# Returns\n\nCustomers may return an item within 30 days of delivery.\n' > notes/returns.md
```

## 2. List the step's tools

On the agent step, list each tool as `server:tool`:

```yaml
steps:
  answer:
    description: Answer the question from the notes.
    execution: agent
    tools:
      - notes:list_directory
      - notes:read_text_file
    max_tool_calls: 5
    tool_timeout: 20
    prompt: |
      Answer this question using only the files in the notes folder.
      List the folder, read what you need, then answer.

      Question: {{ run.params.question }}
    input_schema:
      type: object
      additionalProperties: false
      required: [answer, source_file]
      properties:
        answer:
          type: string
        source_file:
          type: string
```

The model is told about the listed tools and no others. This server offers 14 tools, among them `write_file` and `move_file`. The step above can list a folder and read a text file, and nothing else.

The two limits are optional:

| Key              | Limits                                               | Without it |
| ---------------- | ---------------------------------------------------- | ---------- |
| `max_tool_calls` | How many tool calls the model may make in this step. | 20         |
| `tool_timeout`   | How many seconds one tool call may take.             | 30         |

## 3. Run it

```bash
realm agent --workflow ./ --params '{"question":"How long do customers have to return an item?"}' --provider anthropic --model claude-sonnet-5-5
```

The command uses Anthropic and the model `claude-sonnet-5-5`; with an OpenAI key, use `--provider openai --model <a model from OpenAI's list>` ([OpenAI's models](https://developers.openai.com/api/docs/models)). Version 0.45.0 has a default model, so `--model` can be left out there.

It prints, among the tool server's own start-up lines:

```text
→ [agent] answer
  Answer the question from the notes.
  ✓ → completed

Run complete: b190d283-5b2e-473e-ad61-b086b0342a8a

Result (answer):
{
  "answer": "Within 30 days of delivery.",
  "source_file": "returns.md"
}
```

## 4. Read what was recorded

Every tool call is part of the step's evidence. Add `--verbose` to see what was sent and what came back:

```bash
realm run inspect <run-id> --verbose
```

Under the step it prints:

```text
     Tool calls (2):
       [notes:list_directory]  7ms
         args:   {"path":"."}
         result: {"content":[{"type":"text","text":"[FILE] returns.md\n[FILE] shipping.md"}], …}
       [notes:read_text_file]  4ms
         args:   {"path":"returns.md"}
         result: {"content":[{"type":"text","text":"# Returns\n\nCustomers may return an item within 30 days of delivery.\n…"}], …}
```

Each entry names the server and tool, how long the call took, the arguments the model chose and the result it was given. Without `--verbose`, the same list shows one line for each call.

A call that fails is recorded too, with its error, and the model is told about the failure so that it can try something else:

```text
       [notes:list_directory]  7ms  error: ENOENT: no such file or directory, scandir '[REDACTED]/notes/notes'
```

`realm agent` replaces the values of its environment variables, and the secrets the manifest declares, with `[REDACTED]`: in tool results and in error messages, both in what it records and in what it shows the model, and in the prompt the agent step sends the model. Here it replaced the home folder's path. A run's params are kept as given in the run's file; `realm run export` writes them masked too, except that the export file shows your home folder and user name, which the agent and a log hide when they are 8 or more characters long. It also replaces each value in the forms these programs print it in:

- JSON-escaped, as JavaScript's `JSON.stringify`, Python's `json.dumps` (every non-ASCII character as `\uXXXX`), Go's `json.Marshal`, PHP's `json_encode` (without its `JSON_HEX_…` flags), Perl's `JSON::PP`, jq's `tojson`, Newtonsoft.Json, Gson, System.Text.Json and Jackson write it, and inside another JSON string;
- in quotes with backslash escapes, as Python's `repr()`, `ascii()`, `unicode_escape` and `repr()` of bytes, Node's `util.inspect` (`console.log` of an object), PHP's `var_export` and `addslashes`, Perl's `Data::Dumper`, Go's `%q`, `%#v` and `%+q`, Rust's `{:?}` and `escape_default()`, Ruby's `inspect`, PyYAML's and js-yaml's double-quoted strings, Windows argument quoting (Python's `subprocess.list2cmdline`) and bash's `declare -p` write it, and with each `"` written `\"`;
- shell-quoted, as bash's xtrace, `${v@Q}` and `printf %q`, jq's `@sh`, Python's `shlex.quote` and BusyBox ash's xtrace write it; and with each `'` doubled (YAML single-quoted strings, SQL quoting), each `"` doubled (CSV quoting) or each `$` doubled (Makefiles, Compose files);
- with HTML or XML escaping, as Python's `html.escape` and `xml.sax.saxutils`, .NET's `SecurityElement.Escape`, jq's `@html`, lodash's `_.escape`, Ruby's `CGI.escapeHTML`, Go's `html.EscapeString` and PHP's `htmlspecialchars` write it;
- percent-encoded with upper-case hex, as JavaScript's `encodeURIComponent` and `encodeURI`, Node's `querystring.escape`, `URLSearchParams` and `URL`, Python's `quote`, `quote_plus` and `urlencode`, Java's `URLEncoder`, jq's `@uri`, PHP's `urlencode` and Go's `url.QueryEscape`, `url.PathEscape` and `url.UserPassword` write it;
- in base64 and base64url, also when other text was encoded with it (the forms GitHub's runner and Jenkins mask, and, when its base64 ends in `=` padding, each without its last character), and in lower- or upper-case hex.

Each line of a multi-line value that has 8 or more characters and no spaces or other blank characters is hidden on its own, everywhere. So a declared credentials file also hides lines such as `region=us-east-1`. A line with blanks, such as `key = value`, is not hidden on its own. For every value, it also hides, in the same forms, the value with these escapes read, when that has 8 or more characters: `\n`, `\r`, `\t`, `\b`, `\f`, `\/`, `\\`, `\"`, `\uXXXX` and `\xHH` (a value that ends in a lone `\` has no such reading); and each line of that which has 8 or more characters and no spaces or other blank characters. For a declared secret, some parts of it are also hidden on their own, everywhere: the value without the double quotes around it, when the quoted value has more than 8 characters; the part up to and including its last `&` (or its first `&+`, when it has one), and the part after it, when that part has 6 or more characters (after `&+`, the part starts at the second character after the `+`, and it is hidden when it has 6 or more characters from there); and the value with `\\`, `\'`, `\"` and `\t` read, or with each `\` dropped, or with each `^` dropped (a doubled one kept once; not both at once), when that has 8 or more characters.

Whatever their length, it also hides the value written after a credential's name — such as `password=…`, `DB_PASSWORD=…`, `"client_secret": "…"`, `x-api-key: …` or `Authorization: Bearer …` (there, the scheme word and the credential) — a token after `Bearer ` or `Basic `, the text after `token=`, and the password in a URL written `scheme://user:password@host` (a password holding `/` or a `"` is not read). A name counts when its last words, joined, are one of `token`, `secret`, `password`, `passwd`, `apikey`, `credential`, `credentials`, `cookie`, `accesstoken`, `refreshtoken`, `idtoken`, `clientsecret`, `authorization`, `secretaccesskey`, `sessiontoken`, `privatekey`, `authtoken`, `signingsecret`, `webhooksecret`, `tokensecret`, `apitoken`, `secretkey`, `passphrase`, `pwd`, `secretkeybase`, `encryptionkey`, `masterkey` and `secrets`; so `token_count` and `max_tokens` are not names of credentials, and a name that is `PWD` alone, the shell's working folder, is not one when its value is a path (it starts with `/` or `~`). Your home folder, and every other environment value under it, is hidden whole; `PWD`, `OLDPWD` and `_`, which the shell sets to paths, are not counted, so a path in a working folder under your home folder reads `[REDACTED]/…`, with the home folder's part hidden. A credential's name is also read after a backslash, as in a Windows path (`C:\app\token: …`), and a value written in escaped quotes, such as `password=\'…\'`, is hidden to its closing quote, and so is what is glued to that quote unless it is only closing brackets or quotes before a blank, `&`, `;` or `,` (or the text ends there); a quote met inside a value written without quotes is part of it, unless a quote of the same kind was left open before the name (a `'` between two letters, as in it's, never opens one) and the quote closes — after any closing brackets or quotes, a blank, `&`, `;` or `,` follows, or the text ends (added after version 0.47.1).

This does not catch everything, so do not rely on it to keep a secret out of a record. It leaves alone:

- an environment value of seven characters or fewer, and a declared secret of three or fewer (`realm agent` says so when it loads such a secret);
- an environment value that is the word `false`, or two or three numbers joined by dots, such as the version number `11.8.0` (a declared secret with that value is hidden);
- the values of three variables that npm sets: `npm_package_name`, `npm_package_version` and `npm_lifecycle_event`;
- in base64 and base64url, a value of 6 bytes or fewer that was encoded together with other text (it is hidden at some positions and not at others);
- a value split across lines by the program that printed it, for example base64 wrapped at 76 characters, or a long YAML string folded at its spaces or after an escaped character; a multi-line value written one line at a time keeps its lines that hold blanks;
- a value that a template filter changed in the agent step's prompt (for example `| truncate` or `| upper`), except that a whole line of a multi-line value, and a part of a declared secret, are still hidden there;
- HTML references the named escapers do not write, such as Mustache.js's `&#x2F;` and `&#x3D;`, Handlebars' `&#x3D;` and `&#x60;`, a hex `&#x22;`, decimal `&#47;`, or PHP `htmlentities`' `&eacute;` and `&nbsp;`;
- percent-encoding with lower-case hex, such as `%2f`;
- bash's `$'…'` quoting in a C or POSIX locale, which writes non-ASCII bytes as `\NNN`, and bash 5.2's `\~`;
- PyYAML double-quoted output with `allow_unicode`;
- colour codes (ANSI escape sequences) between a value's characters;
- PHP's `var_export` of a value holding a NUL character, which it writes as `'…' . "\0" . '…'`, and Perl's `Data::Dumper` of a value that holds both a control character (a tab, ESC or DEL, for example) and a non-ASCII character, which it writes with the control character as it is and the non-ASCII character as `\x{…}`;
- a character newer than the Unicode tables of the program that printed it, or of the Node.js that runs Realm, in a value that also holds another non-ASCII character (Python 3.12 to 3.14, older Go, Ruby and Rust; Node 22's tables are older than Node 24's);
- in a URL, its password, `user:password` or token printed on its own, its Basic-auth base64 printed on its own, and the URL without its query string apart from its password: the whole URL is hidden, and for a declared secret the parts around `&`;
- other parts of a value than those named above, such as the password in a connection string written `Password=…` or the token in a value written `Bearer …`;
- other escapings than those named above, or a value mixing several;
- the model's own answers, and the arguments of its tool calls. Neither is checked.

The record keeps each request a step that uses tools makes to the model, and `realm run inspect` shows what they cost, as for any agent step (added after version 0.48.0). A step that Realm 0.48.0 or earlier recorded has no usage; its `cost` line says so.

## See Realm hold the limits

**When the step has used its tool calls**, the model is not given another. Realm sends it this message, with none of the step's tools, and takes its answer:

```text
You have reached the maximum number of tool calls. Produce your final JSON answer now using only what you have already gathered. No further tool calls will be executed.
```

With `max_tool_calls: 1`, the model listed the folder, was sent that message, and answered with what it had. The record shows one tool call. An answer that Realm refuses against the step's schema uses up one of the step's calls as well.

On a Claude model that thinks before it answers, such as Claude Sonnet 5.5, this last request leaves out the model's earlier thinking. Anthropic refuses thinking made under a different list of tools, and this request offers only the answer tool, or none. The model still has its earlier tool calls, their results and what it wrote. This was added in 0.46.0.

**A tool that the server does not have** stops the step before the model is asked anything:

```text
✗ Step 'answer' (tools) failed: Step 'answer' declares tool 'notes:read_pdf' which is not exposed by MCP server 'notes'. Check the tool name against the server's published tool list.
```

**A step that lists tools in a workflow with no `mcp_servers`** is refused when the workflow is loaded:

```text
Invalid workflow: Step 'answer': declares tools but the workflow defines no mcp_servers — no drive can ever offer these tools, so the declaration can never be satisfied. Define an mcp_servers block, or remove 'tools'. (step at line 14)
```

So is a tool whose server is not in the block, and a `tool_timeout` on a step with no tools.

When a step fails in one of these ways while it runs, the run stays open. Fix the cause and continue it. See [Operate runs](operate-runs.md#open-with-no-driver).

## Steps that start other runs

A tool server can be Realm itself, so that an agent step starts runs of other workflows. `max_fan_out` limits how many times the step may call `start_run` or `start_run_batch`. When the limit is reached, the model is sent the same message as above.

## If you see something else

- **`MCP server 'notes': env var NOTES_TOKEN is not set`** A value in the server's `env` names a variable that the shell running `realm agent` does not have. Set it and run again.
- **`Step 'answer' (tools) failed: Cannot read properties of undefined (reading 'indexOf')`** The model asked for a tool that is not in the step's list. The tool was not called. Run the step again; if it keeps happening, say in the prompt which tools the step has.

## See also

- [Agent-step controls reference](../reference/workflow/agent-step-controls.md) covers `tools`, `max_tool_calls`, `max_fan_out` and `tool_timeout` in full.
- [Top-level fields reference](../reference/workflow/top-level-fields.md) covers `mcp_servers`.
- [Evidence](../concepts/evidence.md)
