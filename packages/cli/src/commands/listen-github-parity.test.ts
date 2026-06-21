// Byte-parity proof: the GitHub PR flow expressed as `realm listen` params_map produces exactly the
// same run params as the legacy `realm webhook` hardcoded mapping. This is the gate the Phase B prompt
// required before removing the legacy command — kept as a permanent regression guard.
//
// The equivalence is value-parity over a COMPLETE pull_request payload (the only shape GitHub actually
// delivers for opened/synchronize). On a sparse payload the forms differ in key SHAPE — the legacy
// mapping always emits all 11 keys (absent → undefined), while extractParams omits unresolved keys —
// but both fail the workflow's params_schema (10 of 11 fields required) identically, so the behaviour
// is equivalent on every real GitHub delivery.
import { describe, it, expect } from 'vitest';
import { extractParams } from '../lib/webhook-params.js';

const silentLogger = { warn() {} };

// The params_map a `realm listen` workflow uses for the GitHub PR flow (mirrors example 09's
// trigger.params_map). Dot-path root is { headers, body }.
const GITHUB_PARAMS_MAP: Record<string, string> = {
  pr_number: 'body.pull_request.number',
  pr_url: 'body.pull_request.html_url',
  repo: 'body.repository.full_name',
  repo_owner: 'body.repository.owner.login',
  repo_name: 'body.repository.name',
  pr_title: 'body.pull_request.title',
  base_sha: 'body.pull_request.base.sha',
  head_sha: 'body.pull_request.head.sha',
  author: 'body.sender.login',
  pr_action: 'body.action',
  github_delivery_id: 'headers.x-github-delivery',
};

/**
 * The exact legacy mapping from `realm webhook` (webhook.ts, the removed startWebhookServer, lines
 * ~150-169). Reproduced here verbatim as the parity oracle so the contract survives the deletion.
 */
function legacyGithubParams(
  payload: Record<string, unknown>,
  deliveryId: string | undefined,
): Record<string, unknown> {
  const pr = (payload['pull_request'] as Record<string, unknown> | undefined) ?? {};
  const repo = (payload['repository'] as Record<string, unknown> | undefined) ?? {};
  const sender = (payload['sender'] as Record<string, unknown> | undefined) ?? {};
  const prBase = (pr['base'] as Record<string, unknown> | undefined) ?? {};
  const prHead = (pr['head'] as Record<string, unknown> | undefined) ?? {};
  const repoOwner = (repo['owner'] as Record<string, unknown> | undefined) ?? {};
  return {
    pr_number: pr['number'],
    pr_url: pr['html_url'],
    repo: repo['full_name'],
    repo_owner: repoOwner['login'],
    repo_name: repo['name'],
    pr_title: pr['title'],
    base_sha: prBase['sha'],
    head_sha: prHead['sha'],
    author: sender['login'],
    pr_action: payload['action'],
    github_delivery_id: deliveryId,
  };
}

const SAMPLE_PR_PAYLOAD = {
  action: 'opened',
  pull_request: {
    number: 42,
    html_url: 'https://github.com/org/repo/pull/42',
    title: 'Add the thing',
    base: { sha: 'base_sha_abc123' },
    head: { sha: 'head_sha_def456' },
  },
  repository: {
    full_name: 'org/repo',
    name: 'repo',
    owner: { login: 'org' },
  },
  sender: { login: 'octocat' },
};

describe('GitHub PR flow byte-parity (realm listen params_map ≡ legacy realm webhook mapping)', () => {
  it('produces identical run params for a complete pull_request payload', () => {
    const headers = { 'x-github-delivery': 'delivery-abc-123' };
    const listenParams = extractParams(
      { headers, body: SAMPLE_PR_PAYLOAD },
      GITHUB_PARAMS_MAP,
      silentLogger,
    );
    const legacyParams = legacyGithubParams(SAMPLE_PR_PAYLOAD, headers['x-github-delivery']);
    expect(listenParams).toEqual(legacyParams);
  });

  it('delivery id is surfaced from the X-GitHub-Delivery header via the params_map', () => {
    const headers = { 'x-github-delivery': 'delivery-xyz-789' };
    const listenParams = extractParams(
      { headers, body: SAMPLE_PR_PAYLOAD },
      GITHUB_PARAMS_MAP,
      silentLogger,
    );
    expect(listenParams['github_delivery_id']).toBe('delivery-xyz-789');
  });
});
