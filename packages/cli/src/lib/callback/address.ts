// address.ts — R1.3 C1 (the callback's safe connection): the ONE classifier of the addresses a
// callback may connect to. Pure. An allow-list entry is `public` (any public address) or `private`
// (also loopback, RFC 1918, CGNAT, benchmarking and unique-local IPv6); some addresses are refused
// whatever the entry (unspecified, link-local, multicast, reserved, documentation, the cloud metadata
// addresses). IPv6 is judged by what is allowed: public only inside `2000::/3` and outside its
// special-purpose rows. Explicit CIDR arithmetic on parsed values (no `net.BlockList`, whose IPv4/IPv6
// cross-matching and silent `false` on non-canonical input would need guarding).
import { isIP } from 'node:net';

/** The two allow-list kinds: `public` addresses only, or `private` ones too. */
export type AddressKind = 'public' | 'private';

/** Allowed, or refused with the closed reason word `address`. */
export type AddressVerdict =
  { readonly allowed: true } | { readonly allowed: false; readonly word: 'address' };

const ALLOWED: AddressVerdict = { allowed: true };
const REFUSED: AddressVerdict = { allowed: false, word: 'address' };

/** A dotted-quad IPv4 (as `isIP` accepts it) as a 32-bit unsigned number. */
function v4(text: string): number {
  return text.split('.').reduce((n, part) => n * 256 + Number(part), 0);
}

/** An IPv6 address (as `isIP` accepts it, zone id excluded) as a 128-bit number. */
function v6(text: string): bigint {
  let s = text;
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    const n = v4(tail);
    s = `${s.slice(0, lastColon + 1)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head = '', rest] = s.split('::');
  const left = head === '' ? [] : head.split(':');
  const right = rest === undefined || rest === '' ? [] : rest.split(':');
  const groups =
    rest === undefined
      ? left
      : [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right];
  return groups.reduce((n, g) => (n << 16n) | BigInt(parseInt(g, 16)), 0n);
}

const cidr4 = (base: string, bits: number): readonly [number, number] => [v4(base), bits];
const cidr6 = (base: string, bits: number): readonly [bigint, number] => [v6(base), bits];

const in4 = (n: number, [base, bits]: readonly [number, number]): boolean =>
  bits === 0 || Math.floor(n / 2 ** (32 - bits)) === Math.floor(base / 2 ** (32 - bits));
const in6 = (n: bigint, [base, bits]: readonly [bigint, number]): boolean =>
  n >> BigInt(128 - bits) === base >> BigInt(128 - bits);

/** Refused for every kind. */
const ALWAYS_V4 = [
  cidr4('0.0.0.0', 8), // unspecified, "this network"
  cidr4('169.254.0.0', 16), // link-local, 169.254.169.254 included
  cidr4('224.0.0.0', 4), // multicast
  cidr4('240.0.0.0', 4), // reserved, 255.255.255.255 included
  cidr4('192.0.0.0', 24), // IETF protocol assignments
  cidr4('192.88.99.0', 24), // deprecated 6to4 relay anycast
  cidr4('192.0.2.0', 24), // documentation
  cidr4('198.51.100.0', 24),
  cidr4('203.0.113.0', 24),
];
/** Single addresses refused for every kind, compared by value (cloud metadata and wire servers). */
const ALWAYS_V4_SINGLE = ['169.254.169.254', '100.100.100.200', '168.63.129.16'].map(v4);
/** Refused for `public`, allowed for `private`. */
const PRIVATE_V4 = [
  cidr4('127.0.0.0', 8),
  cidr4('10.0.0.0', 8),
  cidr4('172.16.0.0', 12),
  cidr4('192.168.0.0', 16),
  cidr4('100.64.0.0', 10),
  cidr4('198.18.0.0', 15),
];

/** The only IPv6 block of global unicast addresses. */
const GLOBAL_V6 = cidr6('2000::', 3);
/** Special-purpose rows inside `2000::/3`, refused for every kind. */
const SPECIAL_GLOBAL_V6 = [
  cidr6('2001::', 23), // IETF protocol assignments, Teredo 2001::/32 included
  cidr6('2001:2::', 48), // benchmarking
  cidr6('2001:db8::', 32), // documentation
  cidr6('2002::', 16), // 6to4
  cidr6('3fff::', 20), // documentation
];
const UNIQUE_LOCAL_V6 = cidr6('fc00::', 7);
const MAPPED_V6 = cidr6('::ffff:0:0', 96); // IPv4-mapped: unwrapped
const NAT64_V6 = cidr6('64:ff9b::', 96); // NAT64 well-known prefix: unwrapped
const ALWAYS_V6_SINGLE = [v6('fd00:ec2::254')]; // AWS IMDS over IPv6
const UNSPECIFIED_V6 = 0n;
const LOOPBACK_V6 = 1n;

function classify4(n: number, kind: AddressKind): AddressVerdict {
  if (ALWAYS_V4_SINGLE.includes(n) || ALWAYS_V4.some((c) => in4(n, c))) return REFUSED;
  if (PRIVATE_V4.some((c) => in4(n, c))) return kind === 'private' ? ALLOWED : REFUSED;
  return ALLOWED;
}

function classify6(n: bigint, kind: AddressKind): AddressVerdict {
  // `::` and `::1` as themselves, before any unwrapping (unwrapped, `::1` would read 0.0.0.1).
  if (n === UNSPECIFIED_V6) return REFUSED;
  if (n === LOOPBACK_V6) return kind === 'private' ? ALLOWED : REFUSED;
  // The two disguises that carry an IPv4 address the classifier can judge.
  if (in6(n, MAPPED_V6) || in6(n, NAT64_V6)) return classify4(Number(n & 0xffffffffn), kind);
  if (ALWAYS_V6_SINGLE.includes(n)) return REFUSED;
  if (in6(n, UNIQUE_LOCAL_V6)) return kind === 'private' ? ALLOWED : REFUSED;
  // Public only inside 2000::/3 and outside its special rows: everything else (the rest of ::/8,
  // IPv4-compatible forms, 64:ff9b:1::/48, 100::/8, fe80::/10, fec0::/10, ff00::/8, 4000::/3 …) is
  // refused.
  if (!in6(n, GLOBAL_V6) || SPECIAL_GLOBAL_V6.some((c) => in6(n, c))) return REFUSED;
  return ALLOWED;
}

/**
 * Whether `address` may be connected to for an allow-list entry of `kind`. `address` is the text a
 * lookup returned or an IP literal's canonical form (no brackets). A zone id (`%`) or anything
 * `net.isIP` does not accept is refused.
 */
export function classifyAddress(address: string, kind: AddressKind): AddressVerdict {
  if (address.includes('%')) return REFUSED;
  const family = isIP(address);
  if (family === 4) return classify4(v4(address), kind);
  if (family === 6) return classify6(v6(address), kind);
  return REFUSED;
}

/**
 * Whether `address` is one of this machine's loopback addresses (`127.0.0.0/8`, `::1`, or either
 * mapped into IPv6), for the own-port rule.
 */
export function isLoopbackAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return in4(v4(address), cidr4('127.0.0.0', 8));
  if (family !== 6 || address.includes('%')) return false;
  const n = v6(address);
  return (
    n === LOOPBACK_V6 || (in6(n, MAPPED_V6) && in4(Number(n & 0xffffffffn), cidr4('127.0.0.0', 8)))
  );
}
