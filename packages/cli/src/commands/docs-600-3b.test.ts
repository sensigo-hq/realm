// docs-600-3b.test.ts — caching 3-B (guardrail 7(f), 9): each docs and CHANGELOG sentence 3-B adds or
// rewrites is quoted here word for word and asserted to be on its page, read from the repository. The
// behaviour each states is pinned in the cell named beside it. Each assertion names (a) the change that
// turns it red and (b) what it prints when it fails: the sentence, never a record or an environment.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const flat = (t: string): string => t.replace(/\s+/g, ' ');
const read = (page: string): string => readFileSync(join(ROOT, page), 'utf8');
/** (a) red when the page no longer holds the sentence word for word; (b) prints the sentence. */
function claim(page: string, sentence: string): void {
  expect(flat(read(page)), `${page} no longer says: ${sentence}`).toContain(flat(sentence));
}

const MCP_GUIDE = 'docs/guides/cache-an-mcp-step-prompt.md';

describe('caching 3-B Part B — the MCP door’s stable_prefix (B6)', () => {
  it('the guide: what the field is and holds', () => {
    // The field on a run_step entry: mcp-server `stable-prefix-3b.test.ts` (f), (g).
    claim(
      MCP_GUIDE,
      'When Realm hands an MCP client a step to run (a `run_step` entry in `next_actions`), the entry can say where that fixed start ends, so the client can cache it with its own model provider (added after version 0.48.0).',
    );
    // UTF-16 code units of the received prompt; SHA-256 of the UTF-8 bytes, 64 lowercase hex:
    // `stable-prefix-3b.test.ts` (a), (d), (g) (a client cuts and hashes).
    claim(
      MCP_GUIDE,
      "`chars`: how long the fixed start is in the `prompt` you received, in UTF-16 code units (a JavaScript string's length).",
    );
    claim(
      MCP_GUIDE,
      "`sha256`: the SHA-256 of that start's UTF-8 bytes, as 64 lowercase hexadecimal characters.",
    );
    // Where the start ends: core `render-boundary-3b.test.ts` (A2's boundary, A3's rule).
    claim(
      MCP_GUIDE,
      "The start ends at the prompt's first placeholder whose value can differ between runs.",
    );
    // Hashed after hiding; never cut inside a hidden value: `stable-prefix-3b.test.ts` (a) (the cut
    // moves back), core `redaction-split-3b.test.ts` (the law at every cut).
    claim(
      MCP_GUIDE,
      'Realm hashes the start after it has hidden every secret in the prompt. A hidden value is never cut: when one would cross the boundary, the boundary moves back to where the hidden value starts.',
    );
  });

  it('the guide: when the field is absent', () => {
    // No prompt: core `render-boundary-3b.test.ts` (stepBrief, none without a prompt). Withheld:
    // `stable-prefix-3b.test.ts` (c). Changed beyond the secret: (b), #901's D2-6 input.
    claim(
      MCP_GUIDE,
      '`stable_prefix` is absent when the step has no prompt. It is also absent when Realm cannot vouch that the prompt you received starts with that head: when the server could not read the declared secrets (the reply then withholds values), or when hiding a secret changed more of the prompt than the secret itself.',
    );
  });

  it('tools.md: the run_step entry’s stable_prefix row, and the guide is registered', () => {
    claim(
      'docs/reference/mcp/tools.md',
      "| `stable_prefix` | Where the `prompt`'s fixed start ends, so a client can cache it: `chars` (UTF-16 code units of the `prompt` you received), `unit` (`utf16`) and `sha256` (the SHA-256 of that start's UTF-8 bytes). Absent when Realm cannot vouch for it. See [Cache a step's prompt over MCP](../../guides/cache-an-mcp-step-prompt.md) (added after version 0.48.0). |",
    );
    claim(
      'docs/README.md',
      "- [Cache a step's prompt over MCP](guides/cache-an-mcp-step-prompt.md)",
    );
    claim('website/src/data/docs-sidebar.mjs', "'docs/guides/cache-an-mcp-step-prompt',");
  });
});
