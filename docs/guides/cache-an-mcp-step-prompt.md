# Cache a step's prompt over MCP

<!-- description: Use the stable_prefix field of a run_step entry to cache the fixed start of an agent step's prompt with your own model provider. -->

An agent step's prompt often starts the same way on every run: fixed instructions first, then the run's values. When Realm hands an MCP client a step to run (a `run_step` entry in `next_actions`), the entry can say where that fixed start ends, so the client can cache it with its own model provider (added after version 0.48.0).

## What `stable_prefix` holds

```json
"stable_prefix": { "chars": 51, "unit": "utf16", "sha256": "9f2c…" }
```

- `chars`: how long the fixed start is in the `prompt` you received, in UTF-16 code units (a JavaScript string's length).
- `unit`: always `utf16`.
- `sha256`: the SHA-256 of that start's UTF-8 bytes, as 64 lowercase hexadecimal characters.

The start ends at the prompt's first placeholder whose value can differ between runs. Everything before it comes from the workflow and its context files, so it repeats on every run while they stay the same.

Realm hashes the start after it has hidden every secret in the prompt. A hidden value is never cut: when one would cross the boundary, the boundary moves back to where the hidden value starts.

## Use it

1. Cut the `prompt` you received at `chars`.
2. Check that the SHA-256 of that piece is `sha256`. If it is not, do not cache it.
3. Mark the piece for your provider's cache. With Anthropic, for example, send it as its own text block with `cache_control`, then send the rest of the prompt.

```js
import { createHash } from 'node:crypto';

const { prompt, stable_prefix } = entry;
if (stable_prefix !== undefined) {
  const head = prompt.slice(0, stable_prefix.chars);
  if (createHash('sha256').update(head, 'utf8').digest('hex') === stable_prefix.sha256) {
    // Send `head` as its own block, marked for your provider's cache, then `prompt.slice(head.length)`.
  }
}
```

The example is JavaScript, where a string's length counts UTF-16 code units, as `chars` does.

## When it is absent

`stable_prefix` is absent when the step has no prompt. It is also absent when Realm cannot vouch that the prompt you received starts with that head: when the server could not read the declared secrets (the reply then withholds values), or when hiding a secret changed more of the prompt than the secret itself.

## See also

- [MCP tools](../reference/mcp/tools.md): every field of a `next_actions` entry.
- [Run a workflow with `realm agent`](realm-agent.md): what Realm itself sends a model.
