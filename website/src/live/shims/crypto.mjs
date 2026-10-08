// Clause 2: node:crypto -> sha256 from @noble/hashes (sync, as core needs) + Web Crypto.
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { stubHit } from './log.mjs';
export const createHash = (alg) => {
  if (alg !== 'sha256') throw stubHit('crypto.createHash(' + alg + ')');
  const h = sha256.create();
  const o = {
    update(x) {
      h.update(typeof x === 'string' ? utf8ToBytes(x) : x);
      return o;
    },
    digest(enc) {
      if (enc !== 'hex') throw stubHit('crypto.digest(' + enc + ')');
      return bytesToHex(h.digest());
    },
  };
  return o;
};
export const randomUUID = () => globalThis.crypto.randomUUID();
export const randomBytes = (n) => {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return {
    toString: (e) => {
      if (e !== 'hex') throw stubHit('crypto.randomBytes.toString(' + e + ')');
      return bytesToHex(b);
    },
  };
};
export default { createHash, randomUUID, randomBytes };
