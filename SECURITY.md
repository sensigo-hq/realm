# Security Policy

## Reporting a vulnerability

**Please use GitHub's private vulnerability reporting** — this repository's Security tab →
"Report a vulnerability" → private security advisory form. It is enabled for this repository.

**Do NOT open a public issue or pull request for a suspected vulnerability.** A public report gives
an attacker a head start before a fix ships.

This is a solo-maintained project. We aim to acknowledge a report within a few business days.
Response and fix timelines depend on severity and complexity — we'll keep you updated through the
private advisory thread.

If you cannot use GitHub's private reporting form for some reason, you may email
`mihai.lupu@sensigo.ro` as a fallback — but the private advisory form is the preferred and
primary channel.

## Supported versions

realm is pre-1.0 (`0.x`). Only the **latest published version** on npm (across
`@sensigo/realm`, `@sensigo/realm-cli`, `@sensigo/realm-mcp`, `@sensigo/realm-testing`) receives
security fixes. There is no back-porting to older minor versions and no long-term-support (LTS)
track — upgrading to the latest release is the supported path to a fix.

## Scope

This policy covers the four published npm packages in this repository:

- `@sensigo/realm` (core engine)
- `@sensigo/realm-cli`
- `@sensigo/realm-mcp`
- `@sensigo/realm-testing`

## How we triage dependency advisories

When an automated scan (Dependabot, `npm audit`, or the repository's own `audit-ci` gates)
surfaces an advisory in a dependency, the order of preference is:

1. **Fix-in-range** — bump the dependency within its already-declared semver range, if a patched
   version is available there.
2. **Merge the Dependabot pull request**, if one exists and resolves the advisory.
3. **Only if the code is genuinely not affected** — document it (an [OpenVEX](https://openvex.dev/)
   statement plus the `audit-ci` allowlist) and dismiss.

**We never downgrade a dependency to dodge an advisory.** A downgrade trades a known, documented
risk for an unreviewed, older set of risks — that is not an acceptable substitution.

### Single source of truth for suppressions

The `audit-ci` allowlist (`audit-ci.jsonc` for the PR-blocking gate,
`audit-ci.tier2.jsonc` for the broader weekly scheduled audit) is the **canonical** record of every
suppressed advisory. Any OpenVEX document (see `security/vex/`) and any Dependabot alert dismissal
**mirror** that allowlist — they document the same decision, they never originate it. Each
suppression is scoped to a single GHSA id, carries an `expiry` date, and states a reason.

### Audit boundary — range vs. resolved (an honest limitation)

Our automated audit gates scan **realm's own resolved lockfile** — the exact dependency versions
this repository currently has installed. A downstream consumer installing a published `@sensigo/*`
package resolves its **own** transitive dependency tree, within the semver ranges we've declared,
independently of our lockfile. That resolution can differ from ours — possibly to a newer,
possibly to an older-but-still-vulnerable transitive version. **Our audit gates do not audit what a
consumer's install will actually resolve.** If you depend on a `@sensigo/*` package, run your own
`npm audit` (or equivalent) against your own lockfile.

### Machine-readable VEX records

Suppressed advisories that are `not_affected` are additionally documented as
[OpenVEX](https://openvex.dev/) statements under [`security/vex/`](security/vex/) — see
[`security/vex/GHSA-frvp-7c67-39w9.openvex.json`](security/vex/GHSA-frvp-7c67-39w9.openvex.json)
for the current example.
