#!/usr/bin/env bash
# Packs every plugin in plugins/ with the rules the Dashledge app applies, and fails when a
# released version's package would change without a new version.
#
# Environment: DASHLEDGE_PACKAGE (path to the dashledge-package binary). OUT (optional,
# where the ZIPs go; default dist). GITHUB_STEP_SUMMARY (optional, a Markdown summary).
set -euo pipefail

tool=${DASHLEDGE_PACKAGE:?Set DASHLEDGE_PACKAGE to the dashledge-package binary.}
out=${OUT:-dist}
summary=${GITHUB_STEP_SUMMARY:-/dev/null}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$out"
status=0
count=0

fail() {
  echo "::error file=$1::$2"
  echo "- ❌ **$(basename "$(dirname "$1")")**: $2" >> "$summary"
  status=1
}

echo "## Plugins" >> "$summary"
for manifest in plugins/*/widget.json; do
  [ -f "$manifest" ] || continue
  count=$((count + 1))
  dir=$(dirname "$manifest")
  name=$(basename "$dir")
  id=$(jq -r '.id // ""' "$manifest")
  version=$(jq -r '.version // ""' "$manifest")

  if [[ "$id" != "plugin.dashledge.$name" ]]; then
    fail "$manifest" "Its id is \"$id\". It must be plugin.dashledge.$name, after its folder."
    continue
  fi
  if ! [[ "$version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$ ]]; then
    fail "$manifest" "Its version is \"$version\". The Marketplace needs a version such as 1.2.0."
    continue
  fi
  zip="$out/$name-$version.zip"
  if ! "$tool" pack "$dir" --out "$zip" > "$work/check.json" 2> "$work/error"; then
    fail "$manifest" "$(cat "$work/error")"
    continue
  fi
  sha=$(jq -r .sha256 "$work/check.json")

  # A released version never changes. Packing is deterministic, so the folder as it was
  # at the release tag packs to the released bytes; any difference needs a new version.
  tag="$name-v$version"
  if git rev-parse -q --verify "refs/tags/$tag" > /dev/null; then
    rm -rf "$work/released" && mkdir -p "$work/released"
    git archive "$tag" "$dir" | tar -x -C "$work/released"
    released=$("$tool" pack "$work/released/$dir" --out "$work/released.zip" | jq -r .sha256)
    if [[ "$released" != "$sha" ]]; then
      fail "$manifest" "$version is already released as $tag and this change alters its package. Raise the version in widget.json."
      continue
    fi
    echo "- ✅ **$name** $version, released as \`$tag\`" >> "$summary"
  else
    echo "- 🆕 **$name** $version, not released yet. sha256 \`$sha\`" >> "$summary"
  fi
done

if [ "$count" -eq 0 ]; then echo "No plugins yet." >> "$summary"; fi
exit "$status"
