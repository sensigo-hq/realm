// JsonWorkflowStore — persists registered WorkflowDefinition objects to ~/.realm/workflows/.
import { readFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { WorkflowDefinition } from '../types/workflow-definition.js';
import { WorkflowError } from '../types/workflow-error.js';
import { CURRENT_WORKFLOW_SCHEMA_VERSION } from './yaml-loader.js';
import { atomicWriteFile } from '../store/atomic-write.js';

export interface WorkflowRegistrar {
  /** Persist a WorkflowDefinition under its id, overwriting any previous registration. */
  register(definition: WorkflowDefinition): Promise<void>;
  /** Retrieve a WorkflowDefinition by id. Throws WorkflowError if not found. */
  get(workflowId: string): Promise<WorkflowDefinition>;
  /** List all registered workflows. */
  list(): Promise<WorkflowDefinition[]>;
}

/**
 * Stores WorkflowDefinition objects as JSON files at ~/.realm/workflows/{id}.json.
 */
export class JsonWorkflowStore implements WorkflowRegistrar {
  private readonly dir: string;

  constructor(baseDir?: string) {
    this.dir = baseDir ?? join(homedir(), '.realm', 'workflows');
    mkdirSync(this.dir, { recursive: true });
  }

  async register(definition: WorkflowDefinition): Promise<void> {
    await atomicWriteFile(
      join(this.dir, `${definition.id}.json`),
      JSON.stringify(definition, null, 2),
    );
  }

  async get(workflowId: string): Promise<WorkflowDefinition> {
    const filePath = join(this.dir, `${workflowId}.json`);
    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf8');
    } catch {
      throw new WorkflowError(`Workflow not found: ${workflowId}`, {
        code: 'STATE_WORKFLOW_NOT_FOUND',
        category: 'STATE',
        agentAction: 'report_to_user',
        retryable: false,
      });
    }
    const parsed = JSON.parse(raw) as WorkflowDefinition;
    if (
      parsed.schema_version === undefined ||
      parsed.schema_version < CURRENT_WORKFLOW_SCHEMA_VERSION
    ) {
      throw new WorkflowError(
        'This workflow was registered with an older version of Realm. ' +
          'Re-register it with: realm workflow register <path-to-workflow>',
        {
          code: 'STATE_LEGACY_FORMAT',
          category: 'STATE',
          agentAction: 'report_to_user',
          retryable: false,
        },
      );
    }
    return parsed;
  }

  async list(): Promise<WorkflowDefinition[]> {
    // Re-expressed over listWithDiagnostics (issue #427) so there is ONE directory walk and one
    // parse policy. The interface contract is unchanged — callers that only want the readable
    // definitions still get exactly those, and the skipped files stay skipped here.
    const { workflows } = await this.listWithDiagnostics();
    return workflows;
  }

  /**
   * Everything `list()` returns, plus what it silently drops (issue #427).
   *
   * `list()` skips a file it cannot parse, which is right for a caller that just wants the
   * definitions and wrong for an operator asking what is in their registry: realm cannot audit
   * what it cannot read, and saying nothing about it is how a broken entry stays invisible.
   *
   * `mismatched` covers a second invisible case. `<id>.json` is the write convention, but a
   * hand-edited file can carry an inner id that differs from its basename — and since anything
   * resolving a workflow by id resolves by FILENAME, such an entry is reachable under a name
   * this list would not print. Disclosed rather than corrected.
   *
   * Additive and CONCRETE: `WorkflowRegistrar` is untouched, so no other implementation has to
   * grow a method to satisfy a read surface only the CLI uses.
   */
  async listWithDiagnostics(): Promise<{
    workflows: WorkflowDefinition[];
    unreadable: Array<{ file: string; reason: string }>;
    mismatched: Array<{ file: string; id: string }>;
  }> {
    const entries = readdirSync(this.dir).filter((f) => f.endsWith('.json'));
    const workflows: WorkflowDefinition[] = [];
    const unreadable: Array<{ file: string; reason: string }> = [];
    const mismatched: Array<{ file: string; id: string }> = [];
    for (const entry of entries) {
      let parsed: WorkflowDefinition;
      try {
        const raw = readFileSync(join(this.dir, entry), 'utf8');
        parsed = JSON.parse(raw) as WorkflowDefinition;
      } catch (err) {
        unreadable.push({ file: entry, reason: err instanceof Error ? err.message : String(err) });
        continue;
      }
      workflows.push(parsed);
      if (entry !== `${String(parsed.id)}.json`) {
        mismatched.push({ file: entry, id: String(parsed.id) });
      }
    }
    return { workflows, unreadable, mismatched };
  }
}
