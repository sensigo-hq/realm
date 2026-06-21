// Tests for webhook signature verifiers.
import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyGithub, verifySharedSecret, verifyStripe, verifyHmac } from './webhook-verifiers.js';

const SECRET = 'top-secret';
const BODY = Buffer.from(JSON.stringify({ hello: 'world' }));

function githubHeader(body: Buffer, secret: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}
function stripeSig(ts: number, body: Buffer, secret: string): string {
  return createHmac('sha256', secret)
    .update(Buffer.concat([Buffer.from(`${ts}.`), body]))
    .digest('hex');
}

describe('verifyGithub', () => {
  it('valid signature → true', () => {
    expect(verifyGithub(BODY, githubHeader(BODY, SECRET), SECRET)).toBe(true);
  });
  it('wrong secret → false', () => {
    expect(verifyGithub(BODY, githubHeader(BODY, 'other'), SECRET)).toBe(false);
  });
  it('malformed header (no sha256= prefix) → false', () => {
    const hex = createHmac('sha256', SECRET).update(BODY).digest('hex');
    expect(verifyGithub(BODY, hex, SECRET)).toBe(false);
  });
  it('empty header → false', () => {
    expect(verifyGithub(BODY, '', SECRET)).toBe(false);
  });
  it('tampered body → false', () => {
    expect(verifyGithub(Buffer.from('tampered'), githubHeader(BODY, SECRET), SECRET)).toBe(false);
  });
});

describe('verifySharedSecret', () => {
  const TOKEN = 'Bearer abc123';

  it('matching header value → true', () => {
    expect(verifySharedSecret({ authorization: TOKEN }, 'Authorization', TOKEN)).toBe(true);
  });
  it('case-insensitive header-name lookup → true', () => {
    // Node lowercases incoming header keys; the configured name may be any case.
    expect(verifySharedSecret({ authorization: TOKEN }, 'AUTHORIZATION', TOKEN)).toBe(true);
  });
  it('mismatched value → false', () => {
    expect(verifySharedSecret({ authorization: 'Bearer wrong' }, 'Authorization', TOKEN)).toBe(
      false,
    );
  });
  it('missing header → false', () => {
    expect(verifySharedSecret({ 'x-other': 'v' }, 'Authorization', TOKEN)).toBe(false);
  });
  it('empty header value → false', () => {
    expect(verifySharedSecret({ authorization: '' }, 'Authorization', TOKEN)).toBe(false);
  });
  it('empty secret → false', () => {
    expect(verifySharedSecret({ authorization: TOKEN }, 'Authorization', '')).toBe(false);
  });
  it('empty header name → false', () => {
    expect(verifySharedSecret({ authorization: TOKEN }, '', TOKEN)).toBe(false);
  });
  it('polluted Object.prototype key does not authenticate an empty header map', () => {
    // Defense-in-depth: an inherited prototype property must never satisfy the lookup.
    (Object.prototype as Record<string, unknown>)['authorization'] = TOKEN;
    try {
      expect(verifySharedSecret({}, 'Authorization', TOKEN)).toBe(false);
    } finally {
      delete (Object.prototype as Record<string, unknown>)['authorization'];
    }
  });
});

describe('verifyStripe', () => {
  const now = () => Math.floor(Date.now() / 1000);

  it('valid t= and v1= → true', () => {
    const ts = now();
    const header = `t=${ts},v1=${stripeSig(ts, BODY, SECRET)}`;
    expect(verifyStripe(BODY, header, SECRET, 300)).toBe(true);
  });
  it('expired timestamp (maxAgeSeconds exceeded) → false', () => {
    const ts = now() - 1000;
    const header = `t=${ts},v1=${stripeSig(ts, BODY, SECRET)}`;
    expect(verifyStripe(BODY, header, SECRET, 300)).toBe(false);
  });
  it('valid signature but expired → false (age checked after signature)', () => {
    const ts = now() - 5000;
    const header = `t=${ts},v1=${stripeSig(ts, BODY, SECRET)}`;
    // Signature is correct for ts; only the age check should reject it.
    expect(verifyStripe(BODY, header, SECRET, 60)).toBe(false);
  });
  it('missing t= → false', () => {
    const ts = now();
    expect(verifyStripe(BODY, `v1=${stripeSig(ts, BODY, SECRET)}`, SECRET, 300)).toBe(false);
  });
  it('missing v1= → false', () => {
    expect(verifyStripe(BODY, `t=${now()}`, SECRET, 300)).toBe(false);
  });
  it('multiple v1= values, first wrong, second correct → true', () => {
    const ts = now();
    const header = `t=${ts},v1=deadbeef,v1=${stripeSig(ts, BODY, SECRET)}`;
    expect(verifyStripe(BODY, header, SECRET, 300)).toBe(true);
  });
  it('no maxAgeSeconds: does not check timestamp → true even if old', () => {
    const ts = now() - 100000;
    const header = `t=${ts},v1=${stripeSig(ts, BODY, SECRET)}`;
    expect(verifyStripe(BODY, header, SECRET)).toBe(true);
  });
});

describe('verifyHmac', () => {
  const now = () => Math.floor(Date.now() / 1000);

  it('sha256 hex (default) → true', () => {
    const header = createHmac('sha256', SECRET).update(BODY).digest('hex');
    expect(verifyHmac(BODY, header, SECRET, { headers: {} })).toBe(true);
  });
  it('sha256 base64 → true', () => {
    const header = createHmac('sha256', SECRET).update(BODY).digest('base64');
    expect(verifyHmac(BODY, header, SECRET, { encoding: 'base64', headers: {} })).toBe(true);
  });
  it('sha1 hex → true', () => {
    const header = createHmac('sha1', SECRET).update(BODY).digest('hex');
    expect(verifyHmac(BODY, header, SECRET, { algorithm: 'sha1', headers: {} })).toBe(true);
  });
  it('sha512 hex → true', () => {
    const header = createHmac('sha512', SECRET).update(BODY).digest('hex');
    expect(verifyHmac(BODY, header, SECRET, { algorithm: 'sha512', headers: {} })).toBe(true);
  });
  it('wrong secret → false', () => {
    const header = createHmac('sha256', 'other').update(BODY).digest('hex');
    expect(verifyHmac(BODY, header, SECRET, { headers: {} })).toBe(false);
  });
  it('timestamp_header present, within max_age_seconds → true', () => {
    const ts = String(now());
    const header = createHmac('sha256', SECRET).update(BODY).digest('hex');
    expect(
      verifyHmac(BODY, header, SECRET, {
        timestamp_header: 'x-timestamp',
        max_age_seconds: 300,
        headers: { 'x-timestamp': ts },
      }),
    ).toBe(true);
  });
  it('timestamp_header present, exceeded max_age_seconds → false', () => {
    const ts = String(now() - 1000);
    const header = createHmac('sha256', SECRET).update(BODY).digest('hex');
    expect(
      verifyHmac(BODY, header, SECRET, {
        timestamp_header: 'x-timestamp',
        max_age_seconds: 300,
        headers: { 'x-timestamp': ts },
      }),
    ).toBe(false);
  });
  it('timestamp_header specified but missing from headers → false', () => {
    const header = createHmac('sha256', SECRET).update(BODY).digest('hex');
    expect(
      verifyHmac(BODY, header, SECRET, {
        timestamp_header: 'x-timestamp',
        max_age_seconds: 300,
        headers: {},
      }),
    ).toBe(false);
  });
});
