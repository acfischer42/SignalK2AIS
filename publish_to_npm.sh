#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
export GIT_PAGER=cat
repo=acfischer42/SignalK2AIS
dry_run=false

case "${1:-}" in
  "") ;;
  --dry-run) dry_run=true ;;
  -h|--help)
    printf 'Usage: ./publish_to_npm.sh [--dry-run]\nPrepare version/changelog and stage intended changes first. No version bump is performed.\n'
    exit 0 ;;
  *) printf 'Unknown argument: %s\n' "$1" >&2; exit 1 ;;
esac
if (( $# > 1 )); then
  printf 'Only one optional argument is supported.\n' >&2
  exit 1
fi

fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }
for command in git gh node npm; do
  command -v "$command" >/dev/null || fail "Required command missing: $command"
done

[[ "$(git branch --show-current)" == main ]] || fail 'Switch to main before releasing.'
[[ "$(git remote get-url origin)" == "https://github.com/$repo.git" ||
   "$(git remote get-url origin)" == "git@github.com:$repo.git" ]] ||
  fail 'origin does not point to the expected GitHub repository.'
git diff --quiet || fail 'Stage or commit your intended changes first; unstaged changes exist.'
[[ -z "$(git ls-files --others --exclude-standard)" ]] ||
  fail 'Untracked files exist. Stage intended files or explicitly ignore unrelated files.'
git diff --cached --check
gh auth status

version=$(node -p "require('./package.json').version")
package=$(node -p "require('./package.json').name")
tag="v$version"
node -e '
  const p = require("./package.json")
  const lock = require("./package-lock.json")
  if (!/^\d+\.\d+\.\d+$/.test(p.version)) throw new Error("Use a stable release version")
  if (p.version !== lock.version || p.version !== lock.packages[""].version)
    throw new Error("package-lock.json version does not match")
'
grep -Fxq "## $version" CHANGELOG.md || fail "Missing CHANGELOG.md entry for $version."
if git show-ref --verify --quiet "refs/tags/$tag"; then
  fail "Local tag $tag already exists. Inspect its release instead of reusing it."
fi
remote_tag=$(git ls-remote --tags origin "refs/tags/$tag")
[[ -z "$remote_tag" ]] || fail "Remote tag $tag already exists."
versions=$(npm view "$package" versions --json --prefer-online)
VERSIONS="$versions" RELEASE_VERSION="$version" node -e '
  const versions = JSON.parse(process.env.VERSIONS)
  if ([].concat(versions).includes(process.env.RELEASE_VERSION))
    throw new Error("This version is already published to npm")
'

printf '\nRelease: %s@%s → %s\n' "$package" "$version" "$repo"
git status --short
git diff --cached --stat
if [[ "$dry_run" == false ]]; then
  read -r -p 'Commit staged changes, push, tag and publish this release? [y/N] ' answer
  [[ "$answer" == y || "$answer" == Y ]] || fail 'Release cancelled; nothing pushed.'
fi

npm ci --ignore-scripts
npm test
npm run check
npm pack --dry-run
git diff --quiet || fail 'Validation changed tracked files; inspect them before releasing.'
if [[ "$dry_run" == true ]]; then
  printf '\nDry run passed. No commit, push, tag or publication performed.\n'
  exit 0
fi

git fetch origin main
git merge-base --is-ancestor origin/main HEAD ||
  fail 'Local main is behind or diverged from origin/main. Integrate remote changes and retest.'
if ! git diff --cached --quiet; then
  git commit -m "Release $version" \
    -m 'Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>'
fi
sha=$(git rev-parse HEAD)
git push origin main

wait_for_run() {
  local workflow=$1 ref=$2 run attempt
  for ((attempt = 0; attempt < 30; attempt++)); do
    run=$(gh run list --repo "$repo" --workflow "$workflow" --branch "$ref" \
      --commit "$sha" --event push --limit 10 \
      --json databaseId --jq '.[0].databaseId // empty')
    if [[ -n "$run" ]]; then
      printf 'Watching %s: https://github.com/%s/actions/runs/%s\n' "$workflow" "$repo" "$run"
      gh run watch "$run" --repo "$repo" --exit-status --interval 15
      return
    fi
    sleep 5
  done
  fail "No push-triggered $workflow run found for $sha. Inspect GitHub Actions before proceeding."
}

wait_for_run signalk-ci.yml main
git tag "$tag" "$sha"
git push origin "$tag"
wait_for_run publish.yml "$tag"

for ((attempt = 0; attempt < 12; attempt++)); do
  latest=$(npm view "$package" versions --json --prefer-online)
  if VERSIONS="$latest" RELEASE_VERSION="$version" node -e '
    const versions = JSON.parse(process.env.VERSIONS)
    process.exit([].concat(versions).includes(process.env.RELEASE_VERSION) ? 0 : 1)
  '; then
    npm view "$package@$version" version dist.attestations --json --prefer-online
    printf '\nPublished %s@%s successfully.\n' "$package" "$version"
    exit 0
  fi
  sleep 20
done
fail 'Workflow succeeded, but npm is still processing the version. Verify registry availability later; do not republish.'
