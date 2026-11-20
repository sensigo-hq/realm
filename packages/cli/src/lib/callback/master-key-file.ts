// master-key-file.ts — callback K2a-1 (R1.3; the callback design rev 4 §1.5, the owner's K2 page:
// eaa442b9): makes the master key file `<home>/encryption.key`, once, and never over anything.
//
// The key is 32 random bytes, written as 64 lowercase hexadecimal characters and one `\n` (65 bytes)
// to a temporary file of its own in the same folder (exclusive, owner-only, synced before it is
// closed), then `link`ed to the final name, as the store's fences are placed (`placeFence` in
// `@sensigo/realm-store-sqlite`'s `home.ts`). So the final name never holds part of a key: a reader
// sees no file or the whole file, also after a power loss. `link` fails with EEXIST for ANY entry at
// the final name (a file, a dangling or live link, a folder, a FIFO), and then nothing is replaced,
// read or written. The temporary file is removed in every outcome. It returns no key and prints
// nothing: the key is read back by `resolveMasterKey`.
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  fchmodSync,
  fsyncSync,
  linkSync,
  openSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { MASTER_KEY_FILE } from './master-key.js';

/**
 * Places a new master key file at `<homeDir>/encryption.key`: `'placed'` when this call made it,
 * `'exists'` when any entry was already at that name (it is left as it was). Any other error is thrown
 * as the system gave it (its `code` is what a caller words), and its message names no key.
 */
export function placeMasterKeyFile(homeDir: string): 'placed' | 'exists' {
  const target = join(homeDir, MASTER_KEY_FILE);
  const temp = join(
    homeDir,
    `.${MASTER_KEY_FILE}-${process.pid}-${randomBytes(6).toString('hex')}.tmp`,
  );
  const fd = openSync(temp, 'wx', 0o600);
  try {
    try {
      fchmodSync(fd, 0o600); // whatever the umask, as `placeFence` does
      writeFileSync(fd, `${randomBytes(32).toString('hex')}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(temp, target);
      return 'placed';
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return 'exists';
      throw err;
    }
  } finally {
    try {
      unlinkSync(temp);
    } catch {
      // Only this call made the temporary file; if it cannot be removed, it is left behind.
    }
  }
}
