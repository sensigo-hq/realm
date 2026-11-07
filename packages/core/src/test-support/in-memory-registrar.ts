// issue #616 PR-2c, c1a — test support: a workflow registrar held in memory, for an engine cell that
// reads a definition the way the engine does (`getWorkflowForRun`, whose one read is `get`). Core-
// private: it compiles into dist, `index.ts` does not export it, and the tarball leaves
// `dist/**/test-support/**` out.
import { declareReleaseLine } from '../release-line.js';
import { workflowNotFoundError, type WorkflowRegistrar } from '../workflow/registrar.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';

export class InMemoryWorkflowRegistrar implements WorkflowRegistrar {
  // issue #620 PR-C: a store realm runs against declares this realm's release line (the class form).
  static {
    declareReleaseLine(this);
  }

  private readonly definitions = new Map<string, WorkflowDefinition>();

  /** Holds `definition` under its id, replacing any earlier one. */
  async register(definition: WorkflowDefinition): Promise<void> {
    this.definitions.set(definition.id, definition);
  }

  /** The definition registered under `workflowId`; an unknown id throws the registry's own refusal. */
  async get(workflowId: string): Promise<WorkflowDefinition> {
    const definition = this.definitions.get(workflowId);
    if (definition === undefined) throw workflowNotFoundError(workflowId);
    return definition;
  }

  async list(): Promise<WorkflowDefinition[]> {
    return [...this.definitions.values()];
  }
}
