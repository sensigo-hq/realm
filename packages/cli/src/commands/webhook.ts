// webhook.ts — `realm webhook` (REMOVED).
//
// The legacy GitHub-only webhook server (HMAC verify → dedup → spawn) has been replaced by the
// general `realm listen` server. The GitHub PR flow it served is now expressed as a workflow
// `trigger:` block (`auth: { mode: github }` + a `params_map` of the PR dot-paths), proven
// byte-parity-equivalent to the old hardcoded mapping in listen-github-parity.test.ts. The duplicate
// `checkWebhookSignature` is gone — `realm listen` uses the shared `verifyGithub` verifier.
//
// This thin alias remains only so `realm webhook` returns a helpful migration error instead of an
// "unknown command".
import { Command } from 'commander';

export const webhookCommand = new Command('webhook')
  .description('[removed] use `realm listen` with a workflow trigger: block (auth.mode: github)')
  .allowUnknownOption(true)
  .action(() => {
    console.error(
      '`realm webhook` has been removed. Use `realm listen` with a `trigger:` block ' +
        '(auth.mode: github + a params_map for the PR fields) in your workflow instead. ' +
        'See `realm listen --help`.',
    );
    process.exit(1);
  });
