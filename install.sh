#!/usr/bin/env sh
set -eu

repository="johnlokerse/azure-bicep-visualizer-canvas"
ref=${BICEP_VISUALIZER_REF:-main}
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd || true)
work=""
stage=""
backup=""

cleanup() {
  if [ -n "$backup" ] && [ -e "$backup" ] && [ ! -e "${target:-}" ]; then
    mv "$backup" "$target"
  fi
  [ -z "$stage" ] || [ ! -e "$stage" ] || rm -rf -- "$stage"
  [ -z "$work" ] || [ ! -e "$work" ] || rm -rf -- "$work"
}
trap cleanup EXIT HUP INT TERM

if [ -n "${BICEP_VISUALIZER_SOURCE:-}" ]; then
  source_root=$(CDPATH= cd -- "$BICEP_VISUALIZER_SOURCE" && pwd)
elif [ -n "$script_dir" ] && [ -f "$script_dir/extension/extension.mjs" ]; then
  source_root=$script_dir
else
  for command in curl tar; do
    if ! command -v "$command" >/dev/null 2>&1; then
      printf '%s\n' "Required command not found: $command" >&2
      exit 1
    fi
  done
  work=$(mktemp -d "${TMPDIR:-/tmp}/bicep-visualizer-source.XXXXXX")
  printf '%s\n' "Downloading $repository at $ref..."
  curl --fail --location --retry 3 \
    "https://codeload.github.com/$repository/tar.gz/$ref" |
    tar -xz -C "$work"
  source_root=$(find "$work" -mindepth 1 -maxdepth 1 -type d | head -n 1)
fi

if [ ! -f "$source_root/extension/extension.mjs" ] || [ ! -x "$source_root/scripts/bootstrap-vendor.sh" ]; then
  printf '%s\n' "The downloaded source is missing the extension or bootstrap script." >&2
  exit 1
fi

copilot_home=${COPILOT_HOME:-"$HOME/.copilot"}
parent="$copilot_home/extensions"
target="$parent/bicep-visualizer"
mkdir -p "$parent"
if [ ! -e "$target" ]; then
  interrupted=$(find "$parent" -mindepth 1 -maxdepth 1 -type d -name '.bicep-visualizer.backup.*' | sort | tail -n 1)
  if [ -n "$interrupted" ]; then
    printf '%s\n' "Recovering an interrupted Bicep Visualizer update..."
    mv "$interrupted" "$target"
  fi
fi
stage=$(mktemp -d "$parent/.bicep-visualizer.install.XXXXXX")
for file in \
  extension.mjs server.mjs language-server.mjs \
  bridge.js shell.js index.html graph.html graph.css shell.css \
  copilot-extension.json provenance.json; do
  cp "$source_root/extension/$file" "$stage/$file"
done
mkdir -p "$stage/examples" "$stage/vendor"
cp -R "$source_root/extension/examples/." "$stage/examples/"
cp -R "$source_root/extension/vendor/renderer" "$stage/vendor/renderer"
cp "$source_root/extension/vendor/LICENSE.txt" \
  "$source_root/extension/vendor/ThirdPartyNotices.txt" \
  "$source_root/extension/vendor/language-server.sha256" \
  "$stage/vendor/"

if [ -d "$target/artifacts" ]; then
  mkdir -p "$stage/artifacts"
  cp -R "$target/artifacts/." "$stage/artifacts/"
fi
if [ -f "$target/vendor/.installed-bicep-langserver.json" ] &&
   [ -d "$target/vendor/language-server" ]; then
  cp -R "$target/vendor/language-server" "$stage/vendor/language-server"
  cp "$target/vendor/.installed-bicep-langserver.json" "$stage/vendor/.installed-bicep-langserver.json"
fi

"$source_root/scripts/bootstrap-vendor.sh" "$stage"

backup="$parent/.bicep-visualizer.backup.$$"
rm -rf -- "$backup"
if [ -e "$target" ]; then
  mv "$target" "$backup"
fi
if ! mv "$stage" "$target"; then
  [ ! -e "$backup" ] || mv "$backup" "$target"
  exit 1
fi
stage=""
rm -rf -- "$backup"
backup=""

printf '\n%s\n' "Installed Bicep Visualizer at $target"
printf '%s\n' "Reload extensions in GitHub Copilot, or restart the app."
