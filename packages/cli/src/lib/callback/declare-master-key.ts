// declare-master-key.ts — callback K2a-1 (R1.3; the owner's K2 page: eaa442b9): the one place the
// master key's value is declared to the writer, so no output of this process shows it. Its text form
// is 64 hexadecimal characters in either case, so both are declared: the lowercase and the uppercase
// text, under two names (the writer keeps one value per name). It declares nothing else: a callback
// signing key is not declared here.
import { addDeclaredValues } from '../../output/writer.js';

/** Declares the master key `key` (32 bytes) to the writer, as lowercase and uppercase hex text. */
export function declareMasterKey(key: Uint8Array): void {
  const lower = Buffer.from(key).toString('hex');
  addDeclaredValues({
    'realm:callback-master-key:lowercase': lower,
    'realm:callback-master-key:uppercase': lower.toUpperCase(),
  });
}
