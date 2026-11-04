// bind-failure.test.ts — issue #949: `bindFailureLine` turns the four failures to listen into one
// line each, keyed on `code` AND `syscall`, and gives `undefined` for anything else. Each error is a
// synthetic object (`{ code, syscall }`), never a real environment. (a) red when a row's line
// changes, a code is dropped, or the `syscall` condition is removed; (b) prints the code, the
// syscall and the line.
import { describe, expect, it } from 'vitest';
import { bindFailureLine } from './bind-failure.js';

const IN_USE = (a: string): string =>
  `Error: cannot listen on ${a}: the port is already in use. Stop the program using it, or choose another --port.`;
const DENIED = (a: string): string =>
  `Error: cannot listen on ${a}: permission denied. A port below 1024 usually needs extra rights, and on Windows the system can reserve a port. Choose another --port.`;
const NOT_HERE = (a: string, host: string): string =>
  `Error: cannot listen on ${a}: ${host} is not an address of this machine. Check --host.`;
const NO_NAME = (a: string, host: string): string =>
  `Error: cannot listen on ${a}: the name ${host} cannot be resolved. Check --host.`;

describe('bindFailureLine (issue #949)', () => {
  it.each([
    ['EADDRINUSE', 'listen', '127.0.0.1', IN_USE('127.0.0.1:3000')],
    ['EADDRINUSE', 'listen', '::1', IN_USE('[::1]:3000')],
    ['EACCES', 'listen', '127.0.0.1', DENIED('127.0.0.1:3000')],
    ['EACCES', 'listen', '::1', DENIED('[::1]:3000')],
    ['EADDRNOTAVAIL', 'listen', '127.0.0.1', NOT_HERE('127.0.0.1:3000', '127.0.0.1')],
    ['EADDRNOTAVAIL', 'listen', '::1', NOT_HERE('[::1]:3000', '::1')],
    ['ENOTFOUND', 'getaddrinfo', '127.0.0.1', NO_NAME('127.0.0.1:3000', '127.0.0.1')],
    ['ENOTFOUND', 'getaddrinfo', '::1', NO_NAME('[::1]:3000', '::1')],
    ['EAI_AGAIN', 'getaddrinfo', '127.0.0.1', NO_NAME('127.0.0.1:3000', '127.0.0.1')],
    ['EAI_AGAIN', 'getaddrinfo', '::1', NO_NAME('[::1]:3000', '::1')],
  ])('%s from %s on %s: its one line', (code, syscall, host, line) => {
    expect(bindFailureLine({ code, syscall }, host, 3000), `${code} ${syscall}`).toBe(line);
  });

  it.each([
    ['an EACCES that is not a listen (an unreadable HOME)', { code: 'EACCES', syscall: 'mkdir' }],
    ['an ENOTFOUND from listen', { code: 'ENOTFOUND', syscall: 'listen' }],
    ['another code from listen', { code: 'EPERM', syscall: 'listen' }],
    ['a non-object', 'EADDRINUSE'],
    ['null', null],
    [
      'an object whose code getter throws',
      Object.defineProperty({ syscall: 'listen' }, 'code', {
        get(): never {
          throw new Error('unreadable');
        },
      }),
    ],
  ])('%s: undefined, the caller keeps what it did', (_what, err) => {
    expect(bindFailureLine(err, '127.0.0.1', 3000)).toBeUndefined();
  });
});
