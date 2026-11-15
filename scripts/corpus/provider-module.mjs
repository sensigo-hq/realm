// scripts/corpus/provider-module.mjs — the corpus recorder's model (CP-7): a `--provider-module` for
// `realm agent` that answers each agent step by its input schema, the same answer every time, with no
// network. The recorder copies this file into the folder that holds the PUBLISHED packages (NM) and
// passes that copy, so the import below resolves to the published `LlmProvider` class the CLI itself
// runs: `realm agent` requires `mod.default instanceof LlmProvider`, and a copy under `scripts/` would
// resolve the repository's class instead and be refused.
import { LlmProvider } from '@sensigo/realm-cli/agent';

/** examples/08-pr-review's `write_review`: the four-field review. */
const REVIEW = {
  risk: 'high',
  key_changes: ['deliverWebhook retries a failed POST up to 5 times'],
  recommendation: 'approve',
  review_comment:
    'Approve. The retry loop is bounded by MAX_RETRIES and the new test covers one failed delivery.',
};

/** scripts/corpus/one-step/workflow.yaml's `summarise`. */
const SUMMARY = { summary: 'A note about the corpus recorder.', word_count: 6 };

class CorpusProvider extends LlmProvider {
  async callStep(_prompt, inputSchema) {
    const fields = Object.keys(inputSchema?.properties ?? {})
      .sort()
      .join(',');
    if (fields === 'key_changes,recommendation,review_comment,risk') return { ...REVIEW };
    if (fields === 'summary,word_count') return { ...SUMMARY };
    throw new Error(`the corpus provider has no answer for a step whose schema has: ${fields}`);
  }
}

export default new CorpusProvider();
