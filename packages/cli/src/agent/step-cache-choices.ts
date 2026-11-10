// step-cache-choices.ts — caching 3-M piece D-2: under `--prompt-cache auto`, each agent step's one
// choice for the drive, made before the drive beside the one read of the runner's price file. A step
// without tools is chosen by the provider's rule over its own gaps: the moments its requests started
// in the workflow's earlier runs (C2's read), ended by one reading of the host's clock. A step with
// tools asks for what the provider gives a tool step. `realm agent` hands the result to `runAgent`,
// which passes a step's choice on every one of its calls.
import {
  stepCacheGaps,
  type AutoPriceInput,
  type CacheAuto,
  type CacheAutoPrices,
  type CacheChoice,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { settleAutoFromPriceFile } from './auto-prices.js';
import type { EarlierRuns } from './earlier-runs.js';
import type { AutoStepRule, CallCacheChoice } from './providers/llm-provider.js';

/** Each agent step's choice for the drive, by step name. A step with none sends as the provider does. */
export type StepCacheChoices = ReadonlyMap<string, CallCacheChoice>;

/** What the rule is handed when nothing needs a price: with no kept gap it never reads one. */
const NO_PRICE_NEEDED: AutoPriceInput = { cause: 'no_file' };

/**
 * The choices for `definition`'s agent steps, by the provider's `rule`:
 * - a step with tools: `rule.toolStep`, recorded `{ basis: 'tool_step' }`; none where the provider
 *   has no tool-step choice;
 * - a step without tools, when the read failed (`earlierRuns` undefined): the runner's prior (the
 *   rule over no gap), recorded `{ basis: 'step_gaps_unreadable' }`;
 * - otherwise: the rule over the step's gaps (`stepCacheGaps`), recorded `{ basis: 'step_gaps',
 *   gaps_s, prices? }`; with no gap, the prior and no `prices`.
 * The price file is read once, through `settleAutoFromPriceFile`, and only when something needs a
 * price: a pending choice (`settleAuto`, which the same read then settles) or a step without tools
 * with a kept gap. Returns the choices and, from that read, the settle's `prices` (the start line's)
 * and the one warning line for a file that could not be used.
 */
export async function chooseStepCaches(input: {
  definition: Pick<WorkflowDefinition, 'steps'>;
  earlierRuns: EarlierRuns | undefined;
  rule: AutoStepRule;
  settleAuto:
    ((prices: AutoPriceInput) => { choice: CacheChoice; prices?: CacheAutoPrices }) | undefined;
  economicsPath: string | undefined;
  model: string;
}): Promise<{ choices: StepCacheChoices; prices?: CacheAutoPrices; warning?: string }> {
  // The end of each step's last gap, standing for the next request's start: the host's clock, as a
  // `request_start` is; compared only with an earlier request's start.
  const endMs = Date.now();
  const steps = Object.entries(input.definition.steps)
    .filter(([, step]) => step.execution === 'agent')
    .map(([name, step]) => ({
      name,
      // `run-agent.ts`'s path test, as `cacheableStepCounts` reads it.
      tools: step.tools !== undefined && step.tools.length > 0,
      gaps: stepCacheGaps(
        (input.earlierRuns?.get(name) ?? []).map((found) => found.request.request_start),
        endMs,
      ),
    }));
  const choices = new Map<string, CallCacheChoice>();
  const choose = (prices: AutoPriceInput): void => {
    for (const step of steps) {
      if (step.tools) {
        if (input.rule.toolStep !== undefined) {
          choices.set(step.name, { choice: input.rule.toolStep, auto: { basis: 'tool_step' } });
        }
      } else if (input.earlierRuns === undefined) {
        choices.set(step.name, {
          choice: input.rule.choose([], prices).choice,
          auto: { basis: 'step_gaps_unreadable' },
        });
      } else {
        const outcome = input.rule.choose(step.gaps, prices);
        const auto: CacheAuto = {
          basis: 'step_gaps',
          gaps_s: step.gaps,
          ...(outcome.prices !== undefined ? { prices: outcome.prices } : {}),
        };
        choices.set(step.name, { choice: outcome.choice, auto });
      }
    }
  };
  const needsPrice =
    input.settleAuto !== undefined || steps.some((step) => !step.tools && step.gaps.length > 0);
  if (!needsPrice) {
    choose(NO_PRICE_NEEDED);
    return { choices };
  }
  const read = await settleAutoFromPriceFile(
    (prices) => {
      choose(prices);
      // With nothing pending, this outcome is not kept: only the read's warning is.
      return input.settleAuto?.(prices) ?? { choice: 'off' };
    },
    input.economicsPath,
    input.model,
  );
  return {
    choices,
    ...(read.prices !== undefined ? { prices: read.prices } : {}),
    ...(read.warning !== undefined ? { warning: read.warning } : {}),
  };
}
