// bind-failure.ts — issue #949: a server that cannot listen says so in one line, for `realm listen`
// and `realm serve`, in place of a Node stack. The four causes an operator meets (the port in use,
// permission denied, an address that is not this machine's, a name that does not resolve) each
// get a line naming the host and the port and what to change. Any other error is not a bind
// failure this function knows, and the caller keeps what it did before.

/**
 * The line for a failure to listen, or `undefined` when `err` is not one of the four. Keyed on
 * the pair `code` AND `syscall`: `realm serve`'s catch also wraps building the server, and an
 * `EACCES` from creating a folder (an unreadable HOME) is not a failure to listen. Total: `err` is
 * read inside a `try`, and anything it cannot read gives `undefined`. An IPv6 host (one holding a
 * `:`) is written in brackets in the address, `[::1]:3000`.
 */
export function bindFailureLine(err: unknown, host: string, port: number): string | undefined {
  let code: unknown;
  let syscall: unknown;
  try {
    if (typeof err !== 'object' || err === null) return undefined;
    code = (err as { code?: unknown }).code;
    syscall = (err as { syscall?: unknown }).syscall;
  } catch {
    return undefined;
  }
  const address = `${host.includes(':') ? `[${host}]` : host}:${port}`;
  if (syscall === 'listen') {
    if (code === 'EADDRINUSE') {
      return `Error: cannot listen on ${address}: the port is already in use. Stop the program using it, or choose another --port.`;
    }
    if (code === 'EACCES') {
      return `Error: cannot listen on ${address}: permission denied. A port below 1024 usually needs extra rights, and on Windows the system can reserve a port. Choose another --port.`;
    }
    if (code === 'EADDRNOTAVAIL') {
      return `Error: cannot listen on ${address}: ${host} is not an address of this machine. Check --host.`;
    }
  }
  if (syscall === 'getaddrinfo' && (code === 'ENOTFOUND' || code === 'EAI_AGAIN')) {
    return `Error: cannot listen on ${address}: the name ${host} cannot be resolved. Check --host.`;
  }
  return undefined;
}
