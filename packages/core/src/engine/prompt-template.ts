// Re-export bridge: exposes resolvePromptTemplate as an alias for renderTemplate
// and re-exports resolvePath. Consumed by execution-loop.ts.
export { resolvePath } from './render-template.js';
import { renderTemplate } from './render-template.js';
import type { ContextWrapperFormat } from '../types/workflow-definition.js';
import type { WorkflowContextSnapshot } from '../types/run-record.js';

export function resolvePromptTemplate(
  template: string,
  context: {
    evidenceByStep: Record<string, Record<string, unknown>>;
    runParams: Record<string, unknown>;
    runId?: string;
    workflowContext?: {
      snapshots: Record<string, WorkflowContextSnapshot>;
      wrapper: ContextWrapperFormat;
    };
  },
): string {
  return renderTemplate(template, context);
}
