// N6: static scan of the built bundle on its syntax tree (acorn + eslint-scope): every free name
// (a reference nothing in the bundle defines) must be on the ALLOWLIST of web-standard globals.
// `fetch`, `process`, `Buffer`, `global`, `setImmediate`, `require`, `__dirname`, `__filename` are
// deliberately NOT on it.
import * as acorn from 'acorn';
import * as escope from 'eslint-scope';
export const ALLOWLIST = new Set([
  // ECMAScript intrinsics
  'globalThis',
  'undefined',
  'NaN',
  'Infinity',
  'Object',
  'Function',
  'Array',
  'Number',
  'parseFloat',
  'parseInt',
  'Boolean',
  'String',
  'Symbol',
  'Date',
  'Promise',
  'RegExp',
  'Error',
  'AggregateError',
  'EvalError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'TypeError',
  'URIError',
  'JSON',
  'Math',
  'Intl',
  'ArrayBuffer',
  'SharedArrayBuffer',
  'Atomics',
  'Uint8Array',
  'Int8Array',
  'Uint16Array',
  'Int16Array',
  'Uint32Array',
  'Int32Array',
  'Float32Array',
  'Float64Array',
  'Uint8ClampedArray',
  'BigUint64Array',
  'BigInt64Array',
  'DataView',
  'Map',
  'BigInt',
  'Set',
  'WeakMap',
  'WeakSet',
  'WeakRef',
  'FinalizationRegistry',
  'Proxy',
  'Reflect',
  'decodeURI',
  'decodeURIComponent',
  'encodeURI',
  'encodeURIComponent',
  'escape',
  'unescape',
  'eval',
  'isFinite',
  'isNaN',
  // WHATWG / W3C globals available in window and workers
  'self',
  'window',
  'console',
  'crypto',
  'TextEncoder',
  'TextDecoder',
  'URL',
  'URLSearchParams',
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
  'queueMicrotask',
  'structuredClone',
  'AbortController',
  'AbortSignal',
  'Event',
  'EventTarget',
  'performance',
  'atob',
  'btoa',
  'navigator',
  'File',
]);
export function scanFreeNames(src) {
  const ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module', ranges: true });
  const sm = escope.analyze(ast, { ecmaVersion: 2022, sourceType: 'module' });
  const free = {};
  for (const r of sm.globalScope.through)
    free[r.identifier.name] = (free[r.identifier.name] ?? 0) + 1;
  const offending = Object.entries(free)
    .filter(([n]) => !ALLOWLIST.has(n))
    .sort();
  return { free, offending };
}
