// Clause 2: every other Node built-in (and proper-lockfile) -> a stub that throws if called.
const { stubHit } = require('./log.mjs');
const mk = (mod) =>
  new Proxy(function () {}, {
    get(_, k) {
      if (k === '__esModule' || k === 'default' || typeof k === 'symbol' || k === 'prototype')
        return undefined;
      return mk(mod + '.' + String(k));
    },
    apply() {
      throw stubHit(mod + '()');
    },
    construct() {
      throw stubHit('new ' + mod);
    },
  });
module.exports = (name) => mk(name);
