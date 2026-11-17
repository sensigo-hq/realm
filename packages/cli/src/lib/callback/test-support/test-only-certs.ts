// test-only-certs.ts — R1.3 C1: TEST-ONLY TLS fixtures for the callback cells. These keys protect
// nothing: they were generated for these tests and are published here on purpose. Never use them for
// anything else. Two self-signed EC P-256 pairs, valid for 100 years, each with a subjectAltName:
//   openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 36500 \
//     -subj /CN=example.test -addext subjectAltName=DNS:example.test
// (and the same for `other.test`). Not part of the published package (`files` leaves out test-support).

/** The certificate and key for `example.test`. */
export const EXAMPLE_TEST = {
  cert: `-----BEGIN CERTIFICATE-----
MIIBnTCCAUSgAwIBAgIUHGrrl0RFcdUzVjw0I5rl1gbb2BQwCgYIKoZIzj0EAwIw
FzEVMBMGA1UEAwwMZXhhbXBsZS50ZXN0MCAXDTI2MTExNjIzNTAzNFoYDzIxMjYx
MDIzMjM1MDM0WjAXMRUwEwYDVQQDDAxleGFtcGxlLnRlc3QwWTATBgcqhkjOPQIB
BggqhkjOPQMBBwNCAAT7gT21a4SeAg0uQsDgBV2vKKvyeqlhf0/u9W1l+8VfTrON
C68CSxLvCXRObq6vOjn7I3d9P7adO0P6aTn9eoqPo2wwajAdBgNVHQ4EFgQUXiwh
5ueYv3vx9KCQ8oV6mIftplQwHwYDVR0jBBgwFoAUXiwh5ueYv3vx9KCQ8oV6mIft
plQwDwYDVR0TAQH/BAUwAwEB/zAXBgNVHREEEDAOggxleGFtcGxlLnRlc3QwCgYI
KoZIzj0EAwIDRwAwRAIgW2wZA5rZ+5f13Irf8Lcp3Q/bpgqhouiDFarCMXIvUk4C
IFrZuYHvHhf9xw/WqWUJ1dCYKVIvWB+QEapqs5YddSg0
-----END CERTIFICATE-----
`,
  key: `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgj9D81fcDMDW1tJAf
WMU5PVbgD9/UhcAuohEjPq7EDEKhRANCAAT7gT21a4SeAg0uQsDgBV2vKKvyeqlh
f0/u9W1l+8VfTrONC68CSxLvCXRObq6vOjn7I3d9P7adO0P6aTn9eoqP
-----END PRIVATE KEY-----
`,
};

/** The certificate and key for `other.test`. */
export const OTHER_TEST = {
  cert: `-----BEGIN CERTIFICATE-----
MIIBmTCCAT6gAwIBAgIUR2J3BW+7z3++vHunWt5m19EYMWowCgYIKoZIzj0EAwIw
FTETMBEGA1UEAwwKb3RoZXIudGVzdDAgFw0yNjExMTYyMzUwMzRaGA8yMTI2MTAy
MzIzNTAzNFowFTETMBEGA1UEAwwKb3RoZXIudGVzdDBZMBMGByqGSM49AgEGCCqG
SM49AwEHA0IABGFklii3om5CYEiEyY4CLifs4fx6PKkVsMZnDy3BLBOW2iG7fZ6U
kTgExyZcV40wHtl2SN6X9h7qZFS3ZtkuxKijajBoMB0GA1UdDgQWBBR3+Y5LspyQ
5iKUaOmxxrB4uk2fGDAfBgNVHSMEGDAWgBR3+Y5LspyQ5iKUaOmxxrB4uk2fGDAP
BgNVHRMBAf8EBTADAQH/MBUGA1UdEQQOMAyCCm90aGVyLnRlc3QwCgYIKoZIzj0E
AwIDSQAwRgIhAL0Xq/jXeR8vJDsO6DM2SezNE6AvQAiRvexLZAJ7jg66AiEAs/7e
wqx4wqzcC25IBJnJUMap8jL0ZCbQLFZiI+jZZmY=
-----END CERTIFICATE-----
`,
  key: `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgWP7kAstUb2AaZe9D
fz4TKN7rnF+6WbwL5mEfZossk5OhRANCAARhZJYot6JuQmBIhMmOAi4n7OH8ejyp
FbDGZw8twSwTltohu32elJE4BMcmXFeNMB7Zdkjel/Ye6mRUt2bZLsSo
-----END PRIVATE KEY-----
`,
};
