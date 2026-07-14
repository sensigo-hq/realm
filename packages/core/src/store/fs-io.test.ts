// Tests for the fs-io.ts absence/unreachability primitive (issue #183).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  deleteIfExists,
  readIfExists,
  statIfExists,
  withWin32Retry,
  FsIoError,
  isRetryableArtifactErrno,
  artifactDeleteFailedError,
  toArtifactDeleteFailedError,
} from './fs-io.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fs-io-test-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('deleteIfExists', () => {
  it('ENOENT → resolves false (already gone, success, idempotent)', async () => {
    await expect(deleteIfExists(join(dir, 'never-existed'))).resolves.toBe(false);
  });

  it('deletes an existing file and resolves true', async () => {
    const path = join(dir, 'present.txt');
    await writeFile(path, 'hello');
    await expect(deleteIfExists(path)).resolves.toBe(true);
    await expect(deleteIfExists(path)).resolves.toBe(false); // second call: already gone
  });

  it('a non-ENOENT errno (unlinking a directory) throws a typed FsIoError, never silently succeeds', async () => {
    const dirPath = join(dir, 'a-directory');
    await mkdir(dirPath);
    await expect(deleteIfExists(dirPath)).rejects.toThrow(FsIoError);
    try {
      await deleteIfExists(dirPath);
      expect.unreachable('expected deleteIfExists to throw for a directory target');
    } catch (err) {
      expect(err).toBeInstanceOf(FsIoError);
      const fsErr = err as FsIoError;
      expect(fsErr.path).toBe(dirPath);
      // EISDIR on Linux; some platforms may report EPERM for unlink-on-directory — either way it
      // must NOT be ENOENT (which would mean deleteIfExists incorrectly treated it as absent).
      expect(fsErr.code).not.toBe('ENOENT');
    }
  });
});

describe('readIfExists', () => {
  it('ENOENT → resolves undefined (absent)', async () => {
    await expect(readIfExists(join(dir, 'never-existed'))).resolves.toBeUndefined();
  });

  it('returns raw file contents verbatim — no parsing', async () => {
    const path = join(dir, 'present.txt');
    await writeFile(path, '{"not":"parsed here"}');
    await expect(readIfExists(path)).resolves.toBe('{"not":"parsed here"}');
  });

  it('a non-ENOENT errno (reading a directory) throws a typed FsIoError', async () => {
    const dirPath = join(dir, 'a-directory');
    await mkdir(dirPath);
    await expect(readIfExists(dirPath)).rejects.toThrow(FsIoError);
    try {
      await readIfExists(dirPath);
      expect.unreachable('expected readIfExists to throw for a directory target');
    } catch (err) {
      expect(err).toBeInstanceOf(FsIoError);
      expect((err as FsIoError).code).not.toBe('ENOENT');
    }
  });
});

describe('statIfExists', () => {
  it('ENOENT → resolves undefined (absent)', async () => {
    await expect(statIfExists(join(dir, 'never-existed'))).resolves.toBeUndefined();
  });

  it('returns Stats for an existing path', async () => {
    const path = join(dir, 'present.txt');
    await writeFile(path, 'hello');
    const info = await statIfExists(path);
    expect(info).toBeDefined();
    expect(info!.isFile()).toBe(true);
  });

  it('a non-ENOENT errno throws a typed FsIoError', async () => {
    // A path whose PARENT component is a file, not a directory (ENOTDIR) — corruption, not
    // absence, per the module doc: "ENOTDIR is corruption, not absence — it must be loud."
    const filePath = join(dir, 'a-file');
    await writeFile(filePath, 'hello');
    const bogusChildPath = join(filePath, 'child');
    await expect(statIfExists(bogusChildPath)).rejects.toThrow(FsIoError);
    try {
      await statIfExists(bogusChildPath);
      expect.unreachable('expected statIfExists to throw for a path through a non-directory');
    } catch (err) {
      expect(err).toBeInstanceOf(FsIoError);
      const fsErr = err as FsIoError;
      expect(fsErr.code).toBe('ENOTDIR');
      expect(fsErr.code).not.toBe('ENOENT');
    }
  });
});

describe('isRetryableArtifactErrno', () => {
  it('EACCES/EISDIR/EPERM/EROFS are NOT retryable (permanent — same permission/mount state)', () => {
    expect(isRetryableArtifactErrno('EACCES')).toBe(false);
    expect(isRetryableArtifactErrno('EISDIR')).toBe(false);
    expect(isRetryableArtifactErrno('EPERM')).toBe(false);
    expect(isRetryableArtifactErrno('EROFS')).toBe(false);
  });

  it('EBUSY/EIO ARE retryable (transient — a lock elsewhere, a flaky disk read)', () => {
    expect(isRetryableArtifactErrno('EBUSY')).toBe(true);
    expect(isRetryableArtifactErrno('EIO')).toBe(true);
  });

  it('an unrecognized errno defaults to NOT retryable (conservative)', () => {
    expect(isRetryableArtifactErrno('ESOMETHING_UNKNOWN')).toBe(false);
  });
});

describe('artifactDeleteFailedError / toArtifactDeleteFailedError', () => {
  it('builds a WorkflowError with code, category, and details.failures', () => {
    const err = artifactDeleteFailedError(
      'run-1',
      'SomeStore',
      ['a.json'],
      [{ artifact: 'b.json', code: 'EACCES', message: 'permission denied' }],
    );
    expect(err.code).toBe('ENGINE_ARTIFACT_DELETE_FAILED');
    expect(err.category).toBe('ENGINE');
    expect(err.details['runId']).toBe('run-1');
    expect(err.details['store']).toBe('SomeStore');
    expect(err.details['deleted']).toEqual(['a.json']);
    expect(err.details['failures']).toEqual([
      { artifact: 'b.json', code: 'EACCES', message: 'permission denied' },
    ]);
  });

  it('retryable is true iff ANY failure is retryable', () => {
    const permanentOnly = artifactDeleteFailedError(
      'run-1',
      'S',
      [],
      [{ artifact: 'x', code: 'EACCES', message: 'm' }],
    );
    expect(permanentOnly.retryable).toBe(false);

    const withTransient = artifactDeleteFailedError(
      'run-1',
      'S',
      [],
      [
        { artifact: 'x', code: 'EACCES', message: 'm' },
        { artifact: 'y', code: 'EBUSY', message: 'm2' },
      ],
    );
    expect(withTransient.retryable).toBe(true);
  });

  it('toArtifactDeleteFailedError extracts code/message from an FsIoError', () => {
    const fsErr = new FsIoError(
      'unlink',
      '/some/path',
      Object.assign(new Error('boom'), { code: 'EIO' }),
    );
    const wrapped = toArtifactDeleteFailedError('run-1', 'SomeStore', [], '/some/path', fsErr);
    expect(wrapped.code).toBe('ENGINE_ARTIFACT_DELETE_FAILED');
    expect(wrapped.retryable).toBe(true); // EIO is retryable
    expect(wrapped.details['failures']).toEqual([
      { artifact: '/some/path', code: 'EIO', message: fsErr.message },
    ]);
  });

  it('toArtifactDeleteFailedError falls back to UNKNOWN for a non-errno, non-FsIoError value', () => {
    const wrapped = toArtifactDeleteFailedError(
      'run-1',
      'SomeStore',
      [],
      '/some/path',
      'not an error',
    );
    const failures = wrapped.details['failures'] as Array<{ code: string }>;
    expect(failures[0]!.code).toBe('UNKNOWN');
  });
});

describe('win32 bounded retry policy (withWin32Retry, gated on process.platform)', () => {
  // Mocking the real `unlink`/`readFile`/`stat` bindings from 'node:fs/promises' under
  // Vitest+ESM throws "Cannot spy on export ... Module namespace is not configurable in ESM" —
  // so the retry POLICY (decoupled from any specific fs call — see withWin32Retry's own doc
  // comment) is tested directly here with an injected fake `op`, rather than through
  // deleteIfExists/readIfExists/statIfExists + a mocked fs module.
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('on win32, a transient EBUSY-shaped op is retried and can eventually succeed', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    let calls = 0;
    const op = async (): Promise<string> => {
      calls++;
      if (calls < 3) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      return 'ok';
    };

    await expect(withWin32Retry(op)).resolves.toBe('ok');
    expect(calls).toBe(3);
  });

  it('on win32, a non-retryable errno (EACCES) is NOT retried — throws immediately', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    let calls = 0;
    const op = async (): Promise<never> => {
      calls++;
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    };

    await expect(withWin32Retry(op)).rejects.toMatchObject({ code: 'EACCES' });
    expect(calls).toBe(1); // no retry attempted for a permanent errno
  });

  it('on win32, exhausting all retries still throws the last error', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    let calls = 0;
    const op = async (): Promise<never> => {
      calls++;
      throw Object.assign(new Error('always busy'), { code: 'EBUSY' });
    };

    await expect(withWin32Retry(op)).rejects.toMatchObject({ code: 'EBUSY' });
    expect(calls).toBe(4); // 1 initial attempt + WIN32_RETRY_COUNT (3) retries
  });

  it('on POSIX (non-win32), a transient EBUSY-shaped op is NOT retried — throws immediately', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    let calls = 0;
    const op = async (): Promise<never> => {
      calls++;
      throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    };

    await expect(withWin32Retry(op)).rejects.toMatchObject({ code: 'EBUSY' });
    expect(calls).toBe(1); // POSIX: no retry/delay, even for a transient-shaped errno
  });
});
