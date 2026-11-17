// address.test.ts — R1.3 C1: the classifier of the addresses a callback may connect to. The sample
// lists are the durable copy (`plans/orchestration/r1-result-back/callback/C1-ADDRESS-SAMPLES.md`,
// the web lane's executed arrays corrected by the prompt audit), inlined here.
//
// Each assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, expect, it } from 'vitest';
import { classifyAddress, type AddressKind } from './address.js';

const REFUSED_PUBLIC = [
  '127.0.0.1',
  '127.255.255.255',
  '10.0.0.1',
  '172.16.0.1',
  '172.31.255.255',
  '192.168.1.1',
  '169.254.169.254',
  '169.254.0.1',
  '100.64.0.1',
  '100.127.255.255',
  '100.100.100.200',
  '0.0.0.0',
  '0.1.2.3',
  '192.0.0.192',
  '192.0.2.1',
  '198.51.100.1',
  '203.0.113.1',
  '198.18.0.1',
  '198.19.255.255',
  '240.0.0.1',
  '255.255.255.255',
  '224.0.0.1',
  '239.255.255.250',
  '192.88.99.1',
  '::1',
  '::',
  '::ffff:127.0.0.1',
  '::ffff:7f00:1',
  '::ffff:a9fe:a9fe',
  '::7f00:1',
  '::127.0.0.1',
  '64:ff9b::7f00:1',
  '64:ff9b:1::1',
  '2002:7f00:1::',
  '2002:a9fe:a9fe::',
  '2001::1',
  '2001:0:4136:e378:8000:63bf:3fff:fdd2',
  '2001:2::1',
  '2001:db8::1',
  '3fff::1',
  'fc00::1',
  'fd00:ec2::254',
  'fe80::1',
  'ff02::1',
  'fec0::1',
  '5f00::1',
  '100::1',
];
const ALLOWED_PUBLIC = [
  '::ffff:8.8.8.8',
  '8.8.8.8',
  '1.1.1.1',
  '93.184.216.34',
  '172.32.0.1',
  '172.15.255.255',
  '100.128.0.1',
  '100.63.255.255',
  '198.20.0.1',
  '198.17.255.255',
  '169.253.0.1',
  '192.169.0.1',
  '9.255.255.255',
  '11.0.0.0',
  '223.255.255.255',
  '2606:4700:4700::1111',
  '2001:4860:4860::8888',
  '2a00:1450:4001:81b::200e',
  '2001:200::1',
  '2620:fe::fe',
  '64:ff9b::808:808',
];
/** The ONLY members of the refused list that `private` allows. */
const PRIVATE_ALSO = [
  '127.0.0.1',
  '127.255.255.255',
  '10.0.0.1',
  '172.16.0.1',
  '172.31.255.255',
  '192.168.1.1',
  '100.64.0.1',
  '100.127.255.255',
  '198.18.0.1',
  '198.19.255.255',
  '::1',
  '::ffff:127.0.0.1',
  '::ffff:7f00:1',
  '64:ff9b::7f00:1',
  'fc00::1',
];

const verdicts = (addresses: readonly string[], kind: AddressKind) =>
  Object.fromEntries(addresses.map((a) => [a, classifyAddress(a, kind).allowed]));
const all = (addresses: readonly string[], allowed: boolean) =>
  Object.fromEntries(addresses.map((a) => [a, allowed]));

describe('R1.3 C1 — the classifier, against the samples', () => {
  it('the samples: public refuses the 47 and allows the 21; private allows exactly the 15 more', () => {
    // (a) red when a range is misclassified (e.g. an `::/8` rule that blocks all IPv4, an
    //     unwrap-first `::1`, a missing `2001::/23` row); (b) prints each address that differs.
    expect({
      refusedPublic: verdicts(REFUSED_PUBLIC, 'public'),
      allowedPublic: verdicts(ALLOWED_PUBLIC, 'public'),
      refusedPrivate: verdicts(REFUSED_PUBLIC, 'private'),
      allowedPrivate: verdicts(ALLOWED_PUBLIC, 'private'),
    }).toEqual({
      refusedPublic: all(REFUSED_PUBLIC, false),
      allowedPublic: all(ALLOWED_PUBLIC, true),
      refusedPrivate: Object.fromEntries(REFUSED_PUBLIC.map((a) => [a, PRIVATE_ALSO.includes(a)])),
      allowedPrivate: all(ALLOWED_PUBLIC, true),
    });
  });

  it('the named cases: refused for both kinds, private-only, and NAT64 unwrapped', () => {
    const both = [
      'fec0::1',
      '4000::1',
      '2001:2::1',
      '2001:1::1',
      '192.88.99.1',
      '::7f00:1',
      '::127.0.0.1',
    ];
    const pair = (a: string) => [
      classifyAddress(a, 'public').allowed,
      classifyAddress(a, 'private').allowed,
    ];
    // (a) red when one of these is judged by the wrong rule; (b) prints [public, private] per address.
    expect({
      both: Object.fromEntries(both.map((a) => [a, pair(a)])),
      loopback: pair('::1'),
      uniqueLocal: pair('fc00::1'),
      nat64: pair('64:ff9b::808:808'),
    }).toEqual({
      both: Object.fromEntries(both.map((a) => [a, [false, false]])),
      loopback: [false, true],
      uniqueLocal: [false, true],
      nat64: [true, true],
    });
  });

  it('what is not a canonical address is refused: a zone id, a bracket, a name, a non-canonical spelling', () => {
    const odd = [
      'fe80::1%lo',
      '::1%lo',
      '[::1]',
      'example.test',
      '127.1',
      '2130706433',
      '0x7f000001',
      ' 127.0.0.1',
      '127.0.0.1.',
      '',
    ];
    // (a) red when anything `net.isIP` does not accept, or a zone id, is allowed; (b) prints them.
    expect(Object.fromEntries(odd.map((a) => [a, classifyAddress(a, 'private')]))).toEqual(
      Object.fromEntries(odd.map((a) => [a, { allowed: false, word: 'address' }])),
    );
  });

  it('the single metadata addresses are refused for both kinds, by value (any spelling of the same address)', () => {
    const singles = [
      '169.254.169.254',
      '100.100.100.200',
      '168.63.129.16',
      'fd00:ec2::254',
      'FD00:EC2:0:0:0:0:0:254',
      '::ffff:a9fe:a9fe',
    ];
    // (a) red when a single is compared as text, or missed; (b) prints the verdicts.
    expect(
      Object.fromEntries(
        singles.map((a) => [
          a,
          [classifyAddress(a, 'public').allowed, classifyAddress(a, 'private').allowed],
        ]),
      ),
    ).toEqual(Object.fromEntries(singles.map((a) => [a, [false, false]])));
  });
});
