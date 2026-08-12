// ReplayStore — interface and JsonFileReplayStore for persisting replay results locally.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { ReplayStepResult } from '../commands/replay.js';

/** A persisted replay snapshot: the result of replayRun() + the metadata that produced it. */
export interface ReplayRecord {
  /** Unique ID, always starts with "rpl_". */
  id: string;
  /** The run ID that was replayed. */
  origin_run_id: string;
  /** The workflow ID of the origin run. */
  workflow_id: string;
  /** The overrides that were applied: ["step.field=value", ...] — raw string form. */
  overrides: string[];
  /** The step-level results from replayRun(). */
  results: ReplayStepResult[];
  /** ISO 8601 creation timestamp. */
  created_at: string;
}

export interface ReplayStore {
  /** Persist a replay record. Returns the stored record with its assigned ID. */
  save(record: Omit<ReplayRecord, 'id' | 'created_at'>): Promise<ReplayRecord>;
  /** Get a replay record by ID. Throws a plain Error if not found (not a WorkflowError). */
  get(replayId: string): Promise<ReplayRecord>;
}

export class JsonFileReplayStore implements ReplayStore {
  private readonly replaysDir: string;

  constructor(replaysDir?: string) {
    this.replaysDir = replaysDir ?? join(homedir(), '.realm', 'replays');
  }

  async save(record: Omit<ReplayRecord, 'id' | 'created_at'>): Promise<ReplayRecord> {
    await mkdir(this.replaysDir, { recursive: true });
    const id = `rpl_${randomUUID()}`;
    const created_at = new Date().toISOString();
    const full: ReplayRecord = { ...record, id, created_at };
    await writeFile(join(this.replaysDir, `${id}.json`), JSON.stringify(full, null, 2), 'utf8');
    return full;
  }

  async get(replayId: string): Promise<ReplayRecord> {
    const filePath = join(this.replaysDir, `${replayId}.json`);
    try {
      const content = await readFile(filePath, 'utf8');
      return JSON.parse(content) as ReplayRecord;
    } catch {
      throw new Error(`Replay not found: ${replayId}`);
    }
  }
}
