// N1: a working `Buffer.byteLength` (UTF-8 byte count, as Node's default) and nothing else.
// Every other member throws and is logged, so the guard's zero-calls check counts only those.
import { log, stubHit } from './log.mjs';
const enc = new TextEncoder();
const target = function Buffer() {};
export const Buffer = new Proxy(target, {
  get(_, k) {
    if (k === 'byteLength') {
      return (s) => {
        log.byteLengthCalls++;
        return enc.encode(String(s)).length;
      };
    }
    if (typeof k === 'symbol') return undefined;
    throw stubHit('Buffer.' + String(k));
  },
  apply() {
    throw stubHit('Buffer()');
  },
  construct() {
    throw stubHit('new Buffer');
  },
});
