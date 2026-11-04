// Loads workflow_context entries declared in the workflow definition.
// Called once at run start. On file read failure, records an error snapshot
// and continues — execution is never aborted by a context load failure.
import * as fs from 'node:fs/promises';
import * as crypto from 'node:crypto';
import type { WorkflowDefinition } from '../types/workflow-definition.js';
import type { WorkflowContextSnapshot } from '../types/run-record.js';

/**
 * Reads all workflow_context entries from the workflow definition.
 * Returns a map of entry name → snapshot. If a file cannot be read,
 * the snapshot records the error and uses empty string as content.
 */
export async function loadWorkflowContext(
  definition: WorkflowDefinition,
  // #715 (b) (A.9): `loaded_at` is an EVENT instant on the store's clock, read by the caller when the
  // files are loaded (the write that records the snapshots folds nothing: `update` stamps its own).
  loadedAtInstant: Date,
): Promise<Record<string, WorkflowContextSnapshot>> {
  const entries = definition.workflow_context;
  if (!entries || Object.keys(entries).length === 0) return {};

  const snapshots: Record<string, WorkflowContextSnapshot> = {};
  const loadedAt = loadedAtInstant.toISOString();

  for (const [name, entry] of Object.entries(entries)) {
    const absolutePath = entry.source.path;
    try {
      const content = await fs.readFile(absolutePath, 'utf-8');
      const hash = crypto.createHash('sha256').update(content).digest('hex');
      snapshots[name] = {
        source_path: absolutePath,
        content,
        content_hash: hash,
        loaded_at: loadedAt,
      };
    } catch (err) {
      snapshots[name] = {
        source_path: absolutePath,
        content: '',
        content_hash: '',
        loaded_at: loadedAt,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  return snapshots;
}
