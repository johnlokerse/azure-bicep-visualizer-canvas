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

if [ ! -f "$source_root/extension/extension.mjs" ] || [ ! -f "$source_root/extension/bootstrap.mjs" ]; then
  printf '%s\n' "The downloaded source is missing the canvas extension." >&2
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
for source in "$source_root"/extension/*; do
  if [ ! -f "$source" ]; then
    printf '%s\n' "The extension payload must contain only top-level text files: $source" >&2
    exit 1
  fi
  cp "$source" "$stage/"
done

if [ -d "$target/artifacts" ]; then
  legacy_state=${BICEP_VISUALIZER_STATE:-"$copilot_home/state/bicep-visualizer"}
  mkdir -p "$legacy_state"
  cp -R "$target/artifacts/." "$legacy_state/"
fi

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
printf '%s\n' "Reload extensions in GitHub Copilot, or restart the app. The first launch downloads the pinned Azure Bicep runtime."
