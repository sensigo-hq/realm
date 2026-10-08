// Clause 2: `global` and `setImmediate` throw on any use.
import { stubHit } from './log.mjs';
const mk = (name) =>
  new Proxy(function () {}, {
    get(_, k) {
      if (typeof k === 'symbol') return undefined;
      throw stubHit(name + '.' + String(k));
    },
    apply() {
      throw stubHit(name + '()');
    },
    construct() {
      throw stubHit('new ' + name);
    },
  });
const G = mk('global'),
  S = mk('setImmediate');
export { G as global, S as setImmediate };
