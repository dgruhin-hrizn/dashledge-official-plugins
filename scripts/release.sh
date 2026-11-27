#!/usr/bin/env bash
# Releases one plugin for a tag named <folder>-v<version>: packs plugins/<folder>, attaches
# the ZIP to a new GitHub release and prints the registry listing for it.
#
# Environment: TAG (the pushed tag), DASHLEDGE_PACKAGE (path to the dashledge-package
# binary), GITHUB_REPOSITORY and GITHUB_REPOSITORY_OWNER (set by Actions), GH_TOKEN.
# GITHUB_STEP_SUMMARY (optional, a Markdown summary).
set -euo pipefail

tag=${TAG:?Set TAG to the release tag.}
tool=${DASHLEDGE_PACKAGE:?Set DASHLEDGE_PACKAGE to the dashledge-package binary.}
repo=${GITHUB_REPOSITORY:?}
publisher=${GITHUB_REPOSITORY_OWNER:?}
summary=${GITHUB_STEP_SUMMARY:-/dev/stdout}

die() { echo "::error::$1"; exit 1; }

[[ "$tag" == *-v* ]] || die "Tag releases as <folder>-v<version>, such as download-clients-v1.0.0."
name=${tag%-v*}
version=${tag##*-v}
dir="plugins/$name"
[ -f "$dir/widget.json" ] || die "$tag names $dir, which has no widget.json."
[[ "$(jq -r .id "$dir/widget.json")" == "plugin.dashledge.$name" ]] || die "$dir/widget.json must have the id plugin.dashledge.$name."
[[ "$(jq -r .version "$dir/widget.json")" == "$version" ]] || die "$tag says $version, but $dir/widget.json says $(jq -r .version "$dir/widget.json")."

# Releases come from main, after CI and review: never from a branch nobody merged.
git fetch -q origin main 2> /dev/null || true
base=$(git rev-parse -q --verify origin/main || git rev-parse -q --verify main || true)
commit=$(git rev-list -n 1 "$tag" 2> /dev/null || true)
if [ -z "$base" ] || [ -z "$commit" ] || ! git merge-base --is-ancestor "$commit" "$base"; then
  die "$tag isn't on main. Merge the change first, then tag the merged commit."
fi

# A published ZIP is never replaced: its listing pins the sha256.
if gh release view "$tag" --repo "$repo" > /dev/null 2>&1; then
  die "$tag already has a release. Published packages are never replaced; release a new version."
fi

asset="$name-$version.zip"
mkdir -p dist
"$tool" pack "$dir" --out "dist/$asset" > dist/check.json
sha=$(jq -r .sha256 dist/check.json)
title=$(jq -r .title dist/check.json)
description=$(jq -r '.description // ""' "$dir/widget.json")

listing=$(jq -n --arg id "plugin.dashledge.$name" --arg version "$version" --arg publisher "$publisher" \
  --arg repo "$repo" --arg tag "$tag" --arg asset "$asset" --arg sha "$sha" --arg summary "$description" \
  '{id: $id, version: $version, publisher: $publisher, source: {repo: $repo, tag: $tag, asset: $asset}, sha256: $sha}
   + (if $summary == "" then {} else {summary: $summary} end)')
echo "$listing" > "dist/$name-$version.listing.json"

notes=$(printf '%s %s\n\nsha256 `%s`\n\nTo list it in the Marketplace, add this file to dgruhin-hrizn/dashledge-plugins as `listings/plugin.dashledge.%s/%s.json`:\n\n```json\n%s\n```\n' \
  "$title" "$version" "$sha" "$name" "$version" "$listing")
gh release create "$tag" "dist/$asset" --repo "$repo" --verify-tag --title "$title $version" --notes "$notes"
echo "$notes" >> "$summary"
