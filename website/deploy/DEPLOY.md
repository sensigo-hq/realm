# Deploying realmengine.dev

The live site's own pages (the home page and its demo, /compare/, /how-it-works/, llms.txt) come from
`main`. Its docs come from the newest release's branch, `docs/v<version>`, which is cut from the
release tag. So the live docs describe the Realm that people install. Each docs page says which
version that is, under its title.

## Build

In a checkout of `origin/main` with no changes:

```sh
cd website
npm ci --ignore-scripts --no-audit --no-fund
npm run build:deploy
```

`build:deploy` fetches from origin. It finds the newest release (the highest `vX.Y.Z` tag on origin),
checks its docs branch and builds the site into `website/dist/`. When it stops, it prints why and what
to do, and leaves no `dist/`:

- **"origin has no branch docs/v<version>"**: the branch was never cut. Cut it from the tag with the
  command the line prints (`git push origin refs/tags/v<version>^0:refs/heads/docs/v<version>`), then
  run again.
- **"docs/v<version> does not hold the release tag"**: the branch is not that release's docs.
  Recreate it from the tag, then copy its fixes again with `git cherry-pick -x`.
- **"commit … is not a copy of a commit on main"**: someone committed on the branch directly, or
  copied a fix and edited it, or copied a commit that is not on main. Fixes reach the live docs only
  by landing on main first. One that cannot be copied cleanly stays off the live docs until the next
  release.
- **"… sends readers to …, which is not a page in the <version> docs"**: a site page, llms.txt or a
  redirect links a docs page the release does not have. Change the link on main, or, if that page is
  true of the release, copy its commit onto the branch.
- **"the local tag v<version> points at …, but origin's points at …"**: make the local tag match
  origin's (the published release), then run again.
- **"could not reach origin"**, or **"the build failed"**: fix what the line or the build's own
  error says, then run again.

Every stop and failure ends with "dist/ was removed, so nothing from this run can be deployed."

## Read the list before deploying

A finished build lists the docs commits on main since the release that are not on the site (or says
that every one is), and any docs page on main the site lacks. Each listed commit stays off the live
docs. Copy one onto the branch only if it is true of the release (below).

A warning line means the site's pages were not built from `origin/main` as it is. Build again from a
clean checkout of `origin/main`.

## Deploy

Only after the line `deploy build: done. …`, deploy `website/dist/` in the three steps of the
"Deploy order" at the top of `website/deploy/nginx-site.conf`:

1. `rsync` the new `dist/` without `--delete`;
2. install that file's nginx rules, if they changed, and reload nginx;
3. `rsync` again with `--delete`.

## Put a docs fix on the live docs between releases

A fix that is true of the release lands on main first, as usual. Then it is copied onto the branch:

```sh
git fetch origin
git switch -c docs-fix origin/docs/v<version>
git cherry-pick -x <main commit>      # one main commit per copy, in main's order, with no hand edits
git push origin HEAD:docs/v<version>
```

`-x` writes the line "(cherry picked from commit …)" that the build checks. A copy that needs a hand
edit is refused, so that fix waits for the next release.

To take a copy back, recreate the branch from the tag and copy the others again. That is a force
push, which the repository allows for `docs/*` branches:

```sh
git switch -c docs-redo refs/tags/v<version>
git cherry-pick -x <each main commit to keep>
git push --force origin HEAD:docs/v<version>
```

A `git revert` on the branch carries no "(cherry picked from commit …)" line, so the build refuses
it.

## At a release

Once a new release's tag is on origin, the next deploy builds the docs from its branch. Until that
branch is cut from the tag, the build stops at "origin has no branch docs/v<version>", with the
command that cuts it.
