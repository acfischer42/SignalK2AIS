# Publishing SignalK2AIS

## Project and release infrastructure

- Repository: <https://github.com/acfischer42/SignalK2AIS>
- npm package: <https://www.npmjs.com/package/signalk-write-ais-nmea0183>
- npm maintainer account used for the initial publication: `npmjs0815`.
- First verified automated release: `0.1.13`.
- Local repository: `~/Documents/Git.fischernet.net/Victron/SignalK-WriteAIS-NMEA0183`.
- CI workflow: [signalk-ci.yml](.github/workflows/signalk-ci.yml).
- Release workflow: [publish.yml](.github/workflows/publish.yml).

The display name is **SignalK2AIS**, but the npm package name and plugin ID remain
`signalk-write-ais-nmea0183`. Keep those stable for existing installations.

Publishing to npm makes the package discoverable by Signal K's App Store through
its `signalk-node-server-plugin` and `signalk-webapp` keywords. App Store indexing
and npm registry processing can take time.

## Normal release procedure

Run these commands on your development computer, not on the Ekrano.

### Script shortcut

[publish_to_npm.sh](publish_to_npm.sh) automates local validation, committing
staged changes, pushing `main`, waiting for CI on the exact commit, tagging,
waiting for automated publication and checking npm availability.

First prepare the version, changelog and documentation as described below.
Stage all intended changes explicitly (including this script when first
committing it). The script refuses unstaged changes or untracked files so it
cannot accidentally publish unrelated work.

```sh
# Review and stage your release changes first.
git status --short
git add <intended-files>
./publish_to_npm.sh --dry-run
./publish_to_npm.sh
```

`--dry-run` runs checks, installation, tests and package validation, but does not
commit, push, tag or publish. The normal run asks for confirmation. It does not
bump the version, modify the changelog, run local `npm publish`, or create a
GitHub Release. GitHub authentication (`gh auth login`) is required; local npm
login is not needed for this existing package.

If a tag has already been created and publication fails, inspect/retry the
GitHub workflow using the troubleshooting instructions below rather than
rerunning the script. Do not move tags or reuse published versions.

### 1. Prepare the release

Start on `main` with your intended changes committed and a clean worktree:

```sh
cd ~/Documents/Git.fischernet.net/Victron/SignalK-WriteAIS-NMEA0183
git status --short
git switch main
git pull --ff-only
npm ci --ignore-scripts
npm test
npm run check
```

Inspect any worktree changes before proceeding. Tests validate protocol handling
and simulated Signal K integration; they do not prove physical AIS acceptance.

Bump the version without creating a commit or tag yet:

```sh
npm version patch --no-git-tag-version
node -p "require('./package.json').version"
```

Use `minor` or `major` instead of `patch` when appropriate. This updates both
[package.json](package.json) and [package-lock.json](package-lock.json).

Then:

- Add a version entry to [CHANGELOG.md](CHANGELOG.md).
- Update versioned installation examples in [README.md](README.md).
- Update other directly related documentation.
- Check package contents:

  ```sh
  npm test
  npm run check
  npm pack --dry-run
  ```

The package must contain the entry point, `lib/`, `public/`, both icon copies,
README, changelog and license. No build or install-time scripts are required.

### 2. Commit and push

For example, if the new version is `0.1.14`:

```sh
git add package.json package-lock.json CHANGELOG.md README.md
# Stage any other intended source or documentation changes explicitly.
git diff --cached --check
git diff --cached
git commit -m "Release 0.1.14"
git push origin main
```

Wait for **SignalK Plugin CI** on that commit to succeed:

```sh
gh run list --repo acfischer42/SignalK2AIS --workflow signalk-ci.yml --limit 5
gh run watch RUN_ID --repo acfischer42/SignalK2AIS --exit-status
```

Replace `RUN_ID` with the run for your release commit, not an older successful
run. The shared CI currently covers Linux x64/arm64, macOS and Windows with
Node 22, 24 and 26. The package still declares Node 18 as its minimum; the shared
workflow does not test that older runtime.

### 3. Push the exact version tag

Verify that you are tagging the tested release commit and that the version has
not already been published. Substitute the actual new version:

```sh
git status --short
node -p "require('./package.json').version"
git tag v0.1.14
git push origin v0.1.14
```

The tag must be exactly `v` followed by the version in `package.json`.

The **Publish to npm** workflow then:

1. Runs the full shared Signal K CI again.
2. Waits for any approvals configured on the GitHub `npm` environment.
3. Checks that the tag matches the package version.
4. Publishes to npm using OIDC trusted publishing and signed provenance.

It does not use a stored npm token. Do not manually publish the same version
while this workflow is running.

### 4. Verify publication

```sh
gh run list --repo acfischer42/SignalK2AIS --workflow publish.yml --limit 5
gh run watch RUN_ID --repo acfischer42/SignalK2AIS --exit-status
npm view signalk-write-ais-nmea0183@0.1.14 version dist.attestations --json --prefer-online
npm view signalk-write-ais-nmea0183 dist-tags --json --prefer-online
```

A successful workflow can precede registry availability by several minutes.
Wait before treating an immediate npm 404 as a failure.

Optionally create a GitHub Release with notes for that version:

```sh
gh release create v0.1.14 \
  --repo acfischer42/SignalK2AIS \
  --verify-tag \
  --title "SignalK2AIS 0.1.14" \
  --notes "Describe the changes and any upgrade instructions here."
```

GitHub Releases are not created automatically by the publishing workflow.

## Install a published version on the Ekrano

Run on the Ekrano, substituting the desired published version:

```sh
cd /data/conf/signalk
npm install signalk-write-ais-nmea0183@0.1.14
node -p "require('./node_modules/signalk-write-ais-nmea0183/package.json').version"
svc -t /service/signalk
```

Do not install from `/root`: npm installs locally in the current directory,
which would leave Signal K using its old copy.

Hard-refresh the Signal K admin page and webapp after restarting. Check the
running version displayed in Plugin Config and the app header. After a real
voyage update, verify acceptance on the AIS display.

## Trusted publishing configuration

This is already configured; it is recorded here for recovery or migration.

In the npm package's
[Settings/Access page](https://www.npmjs.com/package/signalk-write-ais-nmea0183/access),
find **Trusted Publisher** and select **GitHub Actions**:

| Setting | Value |
| --- | --- |
| Organization/user | `acfischer42` |
| Repository | `SignalK2AIS` |
| Workflow filename | `publish.yml` |
| Environment | `npm` |
| Allowed actions | Enable direct publishing (`npm publish`) |
| Separate dist-tag management | Not required |

The matching GitHub environment is
[npm](https://github.com/acfischer42/SignalK2AIS/settings/environments).
Required reviewers can be added there if desired.

The publish job needs `id-token: write` and GitHub-hosted runners. It uses
Node 24; npm trusted publishing requires npm 11.5.1 or later. Workflow/action
references are pinned to commit SHAs; update them deliberately.

Changing the repository, workflow filename or environment requires updating the
npm trusted-publisher configuration too. A newly configured publisher must
complete its first successful publication within npm's validation window
(currently two days).

For a brand-new package, perform its first publication manually before
configuring trusted publishing:

```sh
npm login
npm publish --access public
```

Complete browser authentication or 2FA privately. Never commit credentials or
put an npm token into this repository.

## Troubleshooting

- **CI fails:** inspect the failing job before tagging or retrying publication.
  `gh run view RUN_ID --repo acfischer42/SignalK2AIS --log-failed` shows failures.
- **Empty configuration warning:** the plugin requires an explicitly configured
  AIS connection, so shared CI warns when testing `start({})`. Do not bypass
  connection validation or enable the plugin by default just to hide a warning.
- **No screenshots warning:** optional App Store screenshots are not currently
  configured. This does not block publication.
- **OIDC authentication fails:** verify all four trusted-publisher identity
  fields, direct-publish permission, the GitHub environment, npm version and the
  job's `id-token: write` permission. Do not add a token as a workaround.
- **Tag/version mismatch:** fix the release preparation. Do not move an already
  released tag.
- **Version already exists:** npm versions are immutable. If the registry already
  contains the intended release, verify it instead of republishing it. Otherwise
  fix the source and release a new version.
- **Publication failed before npm accepted it:** after fixing configuration,
  rerun the failed GitHub Actions jobs or manually dispatch `publish.yml` on the
  same version tag. A manual dispatch on a branch runs tests but does not publish.
- **Logo missing:** `signalk.appIcon` is `./icon.svg`. Keep the package-root and
  `public/` copies identical and included in the package; restart Signal K to
  reload metadata.
- **Old version on Ekrano:** check the install directory, restart the service,
  and hard-refresh the browser.

## References

- [Signal K App Store publishing](https://demo.signalk.org/documentation/Developing/Plugins/Publishing_to_The_AppStore.html)
- [Signal K plugin CI/CD](https://demo.signalk.org/documentation/Developing/Plugins/Plugin_CI/CD.html)
- [npm trusted publishers](https://docs.npmjs.com/trusted-publishers/)
- [GitHub Actions runs](https://github.com/acfischer42/SignalK2AIS/actions)
