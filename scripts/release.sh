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

# What changed: this version's line in the README's Changes list (check.sh requires it).
changes=$(grep -E "^- \*\*${version//./\\.}:\*\* " "$dir/README.md" | head -1 | sed -E 's/^- \*\*[^*]+:\*\* //')
[ -n "$changes" ] || die "$dir/README.md has no Changes line for $version."

# New grants: what this version declares that the last release didn't. Existing users
# approve those before the update installs; without any, it installs on its own.
# The previous release is the newest earlier tag in this one's history, so a tag left on an
# unmerged branch (which release.sh refused) never counts.
previous=""
for v in $(git tag --list "$name-v*" | sed "s/^$name-v//" | sort -rV); do
  [ "$(printf '%s\n%s\n' "$v" "$version" | sort -V | head -1)" = "$v" ] && [ "$v" != "$version" ] || continue
  if git merge-base --is-ancestor "$name-v$v" "$tag" 2> /dev/null; then previous=$v; break; fi
done
grants=""
if [ -n "$previous" ]; then
  work=$(mktemp -d)
  git archive "$name-v$previous" "$dir" | tar -x -C "$work"
  "$tool" pack "$work/$dir" --out "$work/previous.zip" > "$work/previous.json"
  grants=$(jq -r --slurpfile old "$work/previous.json" --arg prev "$previous" '
    def words: if .kind == "permission" then "the `\(.value)` permission"
      elif .kind == "host" then "the host `\(.value)`"
      elif .kind == "command" then "the connector command `\(.value)`"
      elif .kind == "connector" then "a connector"
      elif .kind == "connectionType" then "the connection type `\(.value)`"
      elif .kind == "connections" then "up to \(.value) connections"
      else "\(.kind) `\(.value)`" end;
    [.grants[] | select(. as $g | ($old[0].grants | index([$g])) == null) | words]
    | if length == 0 then "**No new grants.** Existing installs of \($prev) update on their own."
      else "**New grants.** Existing installs of \($prev) ask to approve these before updating: " + join(", ") + "." end' \
    dist/check.json)
  rm -rf "$work"
fi

listing=$(jq -n --arg id "plugin.dashledge.$name" --arg version "$version" --arg publisher "$publisher" \
  --arg repo "$repo" --arg tag "$tag" --arg asset "$asset" --arg sha "$sha" --arg summary "$description" --arg notes "$changes" \
  '{id: $id, version: $version, publisher: $publisher, source: {repo: $repo, tag: $tag, asset: $asset}, sha256: $sha}
   + (if $summary == "" then {} else {summary: $summary} end) + {notes: $notes}')
echo "$listing" > "dist/$name-$version.listing.json"

notes=$(printf '%s %s\n\n%s\n\n%s%ssha256 `%s`\n\nTo list it in the Marketplace, add this file to dgruhin-hrizn/dashledge-plugins as `listings/plugin.dashledge.%s/%s.json`:\n\n```json\n%s\n```\n' \
  "$title" "$version" "$changes" "$grants" "${grants:+$'\n\n'}" "$sha" "$name" "$version" "$listing")
gh release create "$tag" "dist/$asset" --repo "$repo" --verify-tag --title "$title $version" --notes "$notes"
echo "$notes" >> "$summary"
