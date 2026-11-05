// JsonFileReplayStore — persists replay results locally, one file per replay. It implements core's
// `ReplayStore` (#616 B1: the interface and its record live in `@sensigo/realm`).
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { ReplayRecord, ReplayStore } from '@sensigo/realm';

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
