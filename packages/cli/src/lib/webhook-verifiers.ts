// Webhook signature verifiers — pure functions, no I/O, no logging.
// Every comparison uses timingSafeEqual; every function returns false (never throws)
// on any malformed, missing, or mismatched input.
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Length-safe constant-time comparison of two buffers.
 * timingSafeEqual throws when lengths differ, so guard the length first.
 * The length of an attacker-supplied signature is not itself a secret.
 */
function safeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * Verifies a GitHub webhook signature.
 * Header format: 'sha256=<hex-digest>'
 */
export function verifyGithub(rawBody: Buffer, header: string, secret: string): boolean {
  try {
    if (typeof header !== 'string' || !header.startsWith('sha256=')) {
      return false;
    }
    const provided = header.slice('sha256='.length);
    if (provided === '') {
      return false;
    }
    const computed = createHmac('sha256', secret).update(rawBody).digest('hex');
    return safeEqual(Buffer.from(computed), Buffer.from(provided));
  } catch {
    return false;
  }
}

/**
 * Verifies a shared-secret (header token) webhook — the primary model for sources that
 * authenticate via a user-configured header (e.g. Gorgias: `Authorization: Bearer <token>`).
 *
 * `secret` is the EXACT expected header value the operator configured on the source integration
 * (e.g. 'Bearer abc123' or just 'abc123'). No prefix stripping — an exact, timing-safe compare
 * keeps it unambiguous. `headers` is the request header map (Node lowercases header names);
 * `headerName` is matched case-insensitively. Pure, never throws, returns false on any malformed,
 * missing, or mismatched input.
 */
export function verifySharedSecret(
  headers: Record<string, string>,
  headerName: string,
  secret: string,
): boolean {
  try {
    if (typeof headerName !== 'string' || headerName === '') {
      return false;
    }
    if (typeof secret !== 'string' || secret === '') {
      return false;
    }
    if (typeof headers !== 'object' || headers === null) {
      return false;
    }
    const provided = headers[headerName.toLowerCase()];
    if (typeof provided !== 'string' || provided === '') {
      return false;
    }
    return safeEqual(Buffer.from(provided), Buffer.from(secret));
  } catch {
    return false;
  }
}

/**
 * Verifies a Stripe webhook signature.
 * Header format: 't=<timestamp>,v1=<hex-digest>[,v1=<hex-digest>...]'
 * Signed payload: '<timestamp>.<rawBody>'
 */
export function verifyStripe(
  rawBody: Buffer,
  header: string,
  secret: string,
  maxAgeSeconds?: number,
): boolean {
  try {
    if (typeof header !== 'string' || header === '') {
      return false;
    }

    let timestamp: string | undefined;
    const signatures: string[] = [];
    for (const segment of header.split(',')) {
      const eq = segment.indexOf('=');
      if (eq === -1) {
        continue;
      }
      const key = segment.slice(0, eq).trim();
      const value = segment.slice(eq + 1).trim();
      if (key === 't') {
        timestamp = value;
      } else if (key === 'v1') {
        signatures.push(value);
      }
    }

    if (timestamp === undefined || timestamp === '' || signatures.length === 0) {
      return false;
    }

    const signedPayload = Buffer.concat([Buffer.from(`${timestamp}.`), rawBody]);
    const computed = createHmac('sha256', secret).update(signedPayload).digest('hex');
    const computedBuf = Buffer.from(computed);

    let matched = false;
    for (const sig of signatures) {
      if (safeEqual(computedBuf, Buffer.from(sig))) {
        matched = true;
        break;
      }
    }
    if (!matched) {
      return false;
    }

    // Age check happens AFTER signature verification.
    if (maxAgeSeconds !== undefined) {
      const ts = parseInt(timestamp, 10);
      if (Number.isNaN(ts)) {
        return false;
      }
      if (Math.floor(Date.now() / 1000) - ts > maxAgeSeconds) {
        return false;
      }
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Verifies a generic HMAC webhook signature.
 */
export function verifyHmac(
  rawBody: Buffer,
  header: string,
  secret: string,
  opts: {
    algorithm?: 'sha1' | 'sha256' | 'sha512';
    encoding?: 'hex' | 'base64';
    timestamp_header?: string;
    max_age_seconds?: number;
    headers: Record<string, string>;
  },
): boolean {
  try {
    if (typeof header !== 'string' || header === '') {
      return false;
    }

    const algorithm = opts.algorithm ?? 'sha256';
    const encoding = opts.encoding ?? 'hex';
    const computed = createHmac(algorithm, secret).update(rawBody).digest(encoding);

    if (opts.timestamp_header !== undefined) {
      const tsValue = opts.headers[opts.timestamp_header];
      if (tsValue === undefined) {
        return false;
      }
      if (opts.max_age_seconds !== undefined) {
        const ts = parseInt(tsValue, 10);
        if (Number.isNaN(ts)) {
          return false;
        }
        if (Math.floor(Date.now() / 1000) - ts > opts.max_age_seconds) {
          return false;
        }
      }
    }

    return safeEqual(Buffer.from(computed), Buffer.from(header));
  } catch {
    return false;
  }
}
