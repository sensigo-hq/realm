// signature.ts — callback C3a (R1.3; the Standard Webhooks scheme, as Svix and Stripe sign): the
// signature of one callback try. The signed string is `<webhook-id>.<timestamp>.<body>` over the exact
// bytes sent; the HMAC-SHA-256 key is the UTF-8 bytes of the key's TEXT (the 64 hex characters
// `realm callback key` prints), not the 32 bytes they decode to: a receiver given the text (or its
// `--whsec` form, whose base64 is of those same bytes) checks it with the text. One-way: a receiver
// depends on every part of it.
import { createHmac } from 'node:crypto';

/** One signature: `v1,` and the standard base64 of the HMAC-SHA-256 of the signed string. */
export function callbackSignature(
  keyText: string,
  webhookId: string,
  timestamp: number,
  body: string,
): string {
  const mac = createHmac('sha256', Buffer.from(keyText, 'utf8'))
    .update(`${webhookId}.${timestamp}.${body}`, 'utf8')
    .digest('base64');
  return `v1,${mac}`;
}

/**
 * The `webhook-signature` header: the current key's signature, then the previous key's while one is
 * given (a key being rolled over), separated by a space.
 */
export function callbackSignatureHeader(
  keys: { readonly current: string; readonly previous?: string },
  webhookId: string,
  timestamp: number,
  body: string,
): string {
  const current = callbackSignature(keys.current, webhookId, timestamp, body);
  return keys.previous === undefined
    ? current
    : `${current} ${callbackSignature(keys.previous, webhookId, timestamp, body)}`;
}

/**
 * The `webhook-timestamp` of a try: whole seconds since the epoch, on the system clock, read at the
 * send (a receiver compares it with its own clock). The one clock read of the callback sender; it
 * reads nothing of a run.
 */
export function webhookTimestamp(): number {
  return Math.floor(Date.now() / 1000);
}
