// step-prompt-boundary.ts — caching 3-B (A5, D4.6-12): one narrow export for PR 5's describer
// (`realm workflow validate`, `register`, `watch`). It renders a step's `prompt` the way a run's first
// brief does — against the workflow's static context and no run — and returns the text with its stable
// boundary, so the describer can size the head a provider caches. `renderTemplate` and
// `loadWorkflowContext` stay private to core.
import type { WorkflowDefinition } from '../types/workflow-definition.js';
import type { ContextWrapperFormat } from '../types/workflow-definition.js';
import { loadWorkflowContext } from './workflow-context-loader.js';
import { renderTemplateWithBoundary, type StableBoundary } from './render-template.js';

/**
 * A step's `prompt`, rendered against the workflow's static context (its `workflow_context` files,
 * read now) with no run parameters and no evidence, and its {@link StableBoundary}: every placeholder
 * a run fills is unresolved here, so it is unstable and the boundary falls at the first of them. With
 * no `prompt`, `undefined`. Async: it reads the context files (and, through `loadWorkflowContext`, the
 * clock for the snapshots' `loaded_at`, which no template can read and the render discards).
 */
export async function renderStepPromptWithBoundary(
  definition: WorkflowDefinition,
  stepName: string,
): Promise<{ text: string; stable: StableBoundary } | undefined> {
  const prompt = definition.steps[stepName]?.prompt;
  if (prompt === undefined) return undefined;
  const snapshots = await loadWorkflowContext(definition);
  return renderTemplateWithBoundary(prompt, {
    evidenceByStep: {},
    runParams: {},
    workflowContext: {
      snapshots,
      wrapper: (definition.context_wrapper ?? 'xml') as ContextWrapperFormat,
    },
  });
}
