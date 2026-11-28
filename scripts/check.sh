#!/usr/bin/env bash
# Packs every plugin in plugins/ with the rules the Dashledge app applies, and fails when a
# released version's package would change without a new version.
#
# Environment: DASHLEDGE_PACKAGE (path to the dashledge-package binary). OUT (optional,
# where the ZIPs go; default dist). GITHUB_STEP_SUMMARY (optional, a Markdown summary).
set -euo pipefail

# The oldest Dashledge a first-party plugin may target: the first with the Marketplace.
MIN_APP=0.9.0
# The first Dashledge with sources.setup, which every plugin with a connection uses.
SETUP_APP=0.10.0
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
  # The first-party spec (AGENTS.md): every rule a script can check.
  spec=$(jq -r --arg name "$name" --arg home "https://github.com/dgruhin-hrizn/dashledge-official-plugins/tree/main/plugins/$name" '
    [ (if (.description // "" | length) == 0 then "a description" else empty end),
      (if (.category // "" | length) == 0 then "a category" else empty end),
      (if (.icon // "" | test("\\.svg$")) | not then "an SVG icon" else empty end),
      (if .license != "MIT" then "\"license\": \"MIT\"" else empty end),
      (if .homepage != $home then "\"homepage\": \"" + $home + "\"" else empty end),
      (if (.minAppVersion // "" | length) == 0 then "a minAppVersion" else empty end),
      (if ((.permissions // []) | index("ui")) == null then "the \"ui\" permission (Dashledge’s kit)" else empty end),
      (if .view.theme != true then "\"view\": {\"theme\": true}" else empty end),
      (if .view.viewport != "native" then "\"view\": {\"viewport\": \"native\"}" else empty end),
      (if .collector != null then "no collector" else empty end),
      (if .sources == null then empty else
        (.sources as $s | ($s.types // []) as $types |
          (if [$s, $types[]] | any(has("addressLabel") or has("addressPlaceholder") or has("credentialLabel") or has("usernameLabel"))
             then "its connection texts in sources.setup, not addressLabel, addressPlaceholder, credentialLabel or usernameLabel" else empty end),
          (if ($s.setup.intro // "") == "" and (($types | length) == 0 or ($types | any((.setup.intro // "") == "")))
             then "a sources.setup.intro: what connecting gives the user" else empty end),
          (if (($s.setup.steps // []) | length) == 0 and (($types | length) == 0 or ($types | any(((.setup.steps // []) | length) == 0)))
             then "sources.setup.steps: where to find the address and the credential, for every connection type" else empty end))
      end)
    ] | join(", ")' "$manifest")
  if [ -n "$spec" ]; then
    fail "$manifest" "First-party plugins need $spec. See AGENTS.md."
    continue
  fi
  min=$(jq -r .minAppVersion "$manifest")
  if [ "$(printf '%s\n%s\n' "$MIN_APP" "$min" | sort -V | head -1)" != "$MIN_APP" ]; then
    fail "$manifest" "minAppVersion $min is older than $MIN_APP, the first Dashledge with the Marketplace."
    continue
  fi
  if jq -e '.sources != null' "$manifest" > /dev/null && [ "$(printf '%s\n%s\n' "$SETUP_APP" "$min" | sort -V | head -1)" != "$SETUP_APP" ]; then
    fail "$manifest" "minAppVersion $min is older than $SETUP_APP, the first Dashledge with sources.setup."
    continue
  fi
  if [ ! -f "$dir/README.md" ]; then
    fail "$manifest" "Add $dir/README.md: what it shows, its settings and why it needs each grant."
    continue
  fi
  # The release notes take this version's line from the README's Changes list.
  if ! grep -qE "^- \*\*${version//./\\.}:\*\* " "$dir/README.md"; then
    fail "$manifest" "README.md's Changes list needs a line for $version: \"- **$version:** what changed\"."
    continue
  fi
  missing=$(jq -r '.connector.hosts // [] | .[]' "$manifest" | while read -r host; do grep -qF "$host" "$dir/README.md" || printf '%s ' "$host"; done)
  if [ -n "$missing" ]; then
    fail "$manifest" "README.md must say why it reaches ${missing% }."
    continue
  fi
  if [ ! -f "tests/$name.test.mjs" ]; then
    fail "$manifest" "Add tests/$name.test.mjs, run against recorded replies in tests/$name/."
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

# Every plugin's tests, against recorded replies.
shopt -s nullglob
tests=(tests/*.test.mjs)
if [ ${#tests[@]} -gt 0 ]; then
  if node --test "${tests[@]}"; then
    echo "- ✅ Tests passed" >> "$summary"
  else
    echo "::error::Plugin tests failed."
    echo "- ❌ Tests failed" >> "$summary"
    status=1
  fi
fi
exit "$status"
