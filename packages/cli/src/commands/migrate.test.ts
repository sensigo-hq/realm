import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';

describe('migrate command — structural guard (issue #130)', () => {
  it('T3 — no raw writeFileSync of a workflow file outside atomicWriteFile', async () => {
    // Anti-recurrence, same class as json-file-store.ts's / registrar.ts's T3: the migrate
    // back-fill write must route through the shared atomicWriteFile helper, not a raw sync
    // writer — a raw writeFileSync reintroduces a torn read for a concurrent unlocked reader.
    const src = await readFile(new URL('./migrate.ts', import.meta.url), 'utf8');

    expect(src).not.toMatch(/writeFileSync\(/);
    expect(src).not.toMatch(/\bwriteFile\(/);
    expect(src).toContain("import { atomicWriteFile } from '@sensigo/realm';");

    const atomicIdx = [...src.matchAll(/\batomicWriteFile\(/g)];
    expect(atomicIdx).toHaveLength(1); // the one write path: the origin back-fill
  });
});
