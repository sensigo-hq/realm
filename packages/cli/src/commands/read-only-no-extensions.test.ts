// Read-only commands must NEVER load extension code (R1 was rescoped to step-executing +
// config-validating commands). This is a structural assertion: the read-only command sources
// must not reference the loader module at all, while every wired command must.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const COMMANDS_DIR = dirname(fileURLToPath(import.meta.url));
const LOADER_REF = 'load-project-extensions';

function source(name: string): string {
  return readFileSync(join(COMMANDS_DIR, `${name}.ts`), 'utf8');
}

describe('read-only commands never touch the extensions loader', () => {
  it.each(['replay', 'inspect', 'list', 'diff', 'replay-format'])(
    '%s.ts has no reference to the loader',
    (name) => {
      expect(source(name)).not.toContain(LOADER_REF);
    },
  );

  it.each(['run', 'agent', 'listen', 'serve', 'mcp', 'validate', 'test', 'register', 'watch'])(
    'sanity: %s.ts references the loader (directly or via a shared helper)',
    (name) => {
      const text = source(name);
      const wired = text.includes(LOADER_REF) || text.includes('loadWorkflowForRegistration');
      expect(wired).toBe(true);
    },
  );
});
