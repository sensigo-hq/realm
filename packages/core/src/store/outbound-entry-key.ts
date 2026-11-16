// outbound-entry-key.ts — issue #597 (D1a; D3a): the one shape of an outbound-ledger row's key. Its own
// module, so `reminder-due.ts` can read a question's rows by it without importing the ledger module,
// and so the package entry (which star-exports `outbound-ledger.ts`) does not export it.
import type { OutboundLeaseRequest } from './outbound-ledger.js';

/** The row's key (`entry_key`) of a reminder or the escalation of a question. */
export function keyOf(what: OutboundLeaseRequest['what']): string {
  return what.type === 'reminder'
    ? `gate:${what.gateId}:reminder:${what.occurrence}`
    : `gate:${what.gateId}:escalation`;
}
