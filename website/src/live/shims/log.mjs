// Bundle-local diagnostics shared by every shim. Read through the engine's `diagnostics()` export.
// stubCalls: calls into members that throw (the guard requires 0). fetches: every stand-in request.
// unrouted: stand-in requests it refused (the guard requires 0).
export const log = { stubCalls: [], fetches: [], unrouted: [], byteLengthCalls: 0 };
export function stubHit(name) {
  log.stubCalls.push(name);
  return new Error('realm-demo: ' + name + ' is not available in the browser build');
}
