// JsonWorkflowStore — persists registered WorkflowDefinition objects to ~/.realm/workflows/.
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { WorkflowDefinition } from '../types/workflow-definition.js';
import { WorkflowError } from '../types/workflow-error.js';
import { CURRENT_WORKFLOW_SCHEMA_VERSION } from './yaml-loader.js';

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
    writeFileSync(
      join(this.dir, `${definition.id}.json`),
      JSON.stringify(definition, null, 2),
      'utf8',
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
    const entries = readdirSync(this.dir).filter((f) => f.endsWith('.json'));
    const results: WorkflowDefinition[] = [];
    for (const entry of entries) {
      try {
        const raw = readFileSync(join(this.dir, entry), 'utf8');
        results.push(JSON.parse(raw) as WorkflowDefinition);
      } catch {
        // Skip files that fail to parse
      }
    }
    return results;
  }
}
