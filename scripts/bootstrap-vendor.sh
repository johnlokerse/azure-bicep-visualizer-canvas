#!/usr/bin/env sh
set -eu

VERSION="0.46.1"
ARCHIVE_URL="https://github.com/Azure/bicep/releases/download/v${VERSION}/bicep-langserver.zip"
ARCHIVE_SHA256="b8224c8e941cde9698747ddd97c930a25097bf688e4e43e4acdd21ca8c24656a"
LANGSERVER_SHA256="2756e192acbcc8a1a84b41c54b48349381a3b4cd3c38b6f1fc568207ccb71513"
RENDERER_SHA256="44e6aea537929a9a2da01abec9030369e09b22568b94efd1c47198d852cd64a0"
LICENSE_SHA256="c2cfccb812fe482101a8f04597dfc5a9991a6b2748266c47ac91b6a5aae15383"
NOTICES_SHA256="ebb6d7f745eecff538d2bc47a2fb2d3c67b3822b7b04e576afc3b6de623a0f7a"

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
target=${1:-"$script_dir/../extension"}

case "$target" in
  ""|"/") printf '%s\n' "Refusing unsafe target: $target" >&2; exit 1 ;;
esac
if [ ! -f "$target/extension.mjs" ]; then
  printf '%s\n' "Target is not a Bicep Visualizer extension: $target" >&2
  exit 1
fi

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$1" | awk '{print $NF}'
  else
    printf '%s\n' "A SHA-256 tool (sha256sum, shasum, or openssl) is required." >&2
    exit 1
  fi
}

valid_language_server() {
  root=$1
  manifest="$target/vendor/language-server.sha256"
  [ -d "$root" ] && [ -f "$manifest" ] || return 1
  [ "$(find "$root" -type f | wc -l | tr -d ' ')" = "241" ] || return 1
  while IFS= read -r entry; do
    expected=${entry%%  *}
    relative=${entry#*  }
    [ "$entry" != "$relative" ] || return 1
    [ "$(sha256_file "$root/$relative" 2>/dev/null || true)" = "$expected" ] || return 1
  done < "$manifest"
}

valid_install() {
  [ -f "$target/vendor/.installed-bicep-langserver.json" ] &&
    valid_language_server "$target/vendor/language-server" &&
    [ "$(sha256_file "$target/vendor/renderer/index.js" 2>/dev/null || true)" = "$RENDERER_SHA256" ] &&
    [ "$(sha256_file "$target/vendor/LICENSE.txt" 2>/dev/null || true)" = "$LICENSE_SHA256" ] &&
    [ "$(sha256_file "$target/vendor/ThirdPartyNotices.txt" 2>/dev/null || true)" = "$NOTICES_SHA256" ] &&
    grep -q "$ARCHIVE_SHA256" "$target/vendor/.installed-bicep-langserver.json"
}

if valid_install; then
  printf '%s\n' "Azure Bicep v${VERSION} vendor files are already installed."
  exit 0
fi

for command in curl unzip; do
  if ! command -v "$command" >/dev/null 2>&1; then
    printf '%s\n' "Required command not found: $command" >&2
    exit 1
  fi
done

work=$(mktemp -d "${TMPDIR:-/tmp}/bicep-visualizer.XXXXXX")
cleanup() {
  rm -rf -- "$work"
}
trap cleanup EXIT HUP INT TERM

archive=${BICEP_VISUALIZER_LANGSERVER_ARCHIVE:-"$work/bicep-langserver.zip"}
if [ -n "${BICEP_VISUALIZER_LANGSERVER_ARCHIVE:-}" ]; then
  if [ ! -f "$archive" ]; then
    printf '%s\n' "BICEP_VISUALIZER_LANGSERVER_ARCHIVE does not name a file: $archive" >&2
    exit 1
  fi
else
  printf '%s\n' "Downloading Azure Bicep v${VERSION} from the official GitHub release..."
  curl --fail --location --retry 3 --output "$archive" "$ARCHIVE_URL"
fi

actual=$(sha256_file "$archive")
if [ "$actual" != "$ARCHIVE_SHA256" ]; then
  printf '%s\n' "Checksum mismatch for bicep-langserver.zip." "Expected: $ARCHIVE_SHA256" "Actual:   $actual" >&2
  exit 1
fi

mkdir -p "$work/unpacked"
unzip -q "$archive" -d "$work/unpacked"

language_server="$work/unpacked"
if [ "$(sha256_file "$target/vendor/renderer/index.js")" != "$RENDERER_SHA256" ] ||
   [ "$(sha256_file "$language_server/Bicep.LangServer.dll")" != "$LANGSERVER_SHA256" ] ||
   ! valid_language_server "$language_server"; then
  printf '%s\n' "Extracted Azure Bicep files did not match the pinned release." >&2
  exit 1
fi

mkdir -p "$target/vendor"
rm -rf -- "$target/vendor/language-server"
mv "$language_server" "$target/vendor/language-server"
cat > "$target/vendor/.installed-bicep-langserver.json" <<EOF
{
  "version": "v${VERSION}",
  "archiveUrl": "${ARCHIVE_URL}",
  "archiveSha256": "${ARCHIVE_SHA256}"
}
EOF

printf '%s\n' "Installed Azure Bicep v${VERSION} language server into $target/vendor."
