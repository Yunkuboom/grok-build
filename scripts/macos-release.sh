#!/usr/bin/env bash
# Apple Silicon release for Grok Build.
# Remap local build paths, bundle the phone page, sign the finished app, then
# create the DMG. Do not change files inside the .app after codesign.
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "scripts/macos-release.sh builds macOS Apple Silicon (arm64) only." >&2
  exit 1
fi

ROOT="$(pwd -P)"
LOGICAL="$(pwd)"
export CARGO_HOME="${CARGO_HOME:-$ROOT/.cargo-release-home}"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/src-tauri/target}"
RUSTUP_DIR="${RUSTUP_HOME:-$HOME/.rustup}"

prefixes=()
add_prefix() {
  local from="$1"
  local to="$2"
  [[ -n "$from" && "$from" != "/" ]] || return 0
  prefixes+=("$from"$'\t'"$to")
  if [[ "$from" == /private/* ]]; then
    prefixes+=("${from#/private}"$'\t'"$to")
  fi
}

add_prefix "$CARGO_HOME" "/cargo"
add_prefix "$RUSTUP_DIR" "/rustup"
add_prefix "$ROOT" "/src"
if [[ "$LOGICAL" != "$ROOT" ]]; then
  add_prefix "$LOGICAL" "/src"
fi
add_prefix "$HOME" "/home"

CONFIG="$ROOT/.cargo/config.toml"
if [[ -e "$CONFIG" ]]; then
  echo "Refusing to overwrite an existing .cargo/config.toml." >&2
  exit 1
fi
mkdir -p "$ROOT/.cargo"
cleanup() {
  rm -f "$CONFIG"
  rmdir "$ROOT/.cargo" 2>/dev/null || true
}
trap cleanup EXIT

python3 - "$CONFIG" "${prefixes[@]}" <<'PY'
import json, sys
dest = sys.argv[1]
pairs = []
for item in sys.argv[2:]:
    src, to = item.split("\t", 1)
    if src and src != "/":
        pairs.append((src, to))
pairs.sort(key=lambda pair: len(pair[0]), reverse=True)
seen = set()
lines = ["[build]", "rustflags = ["]
for src, to in pairs:
    flag = f"--remap-path-prefix={src}={to}"
    if flag in seen:
        continue
    seen.add(flag)
    lines.append(f"  {json.dumps(flag)},")
lines.append("]")
lines.append("")
open(dest, "w", encoding="utf-8").write("\n".join(lines))
PY

npm ci
npx tauri build --bundles app

APP="$ROOT/src-tauri/target/release/bundle/macos/Grok Build.app"
if [[ ! -d "$APP/Contents/Resources/dist" ]]; then
  echo "Phone page resources are missing from the app bundle." >&2
  exit 1
fi

codesign --force --sign - "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"

VERSION="$(python3 -c 'import json; print(json.load(open("src-tauri/tauri.conf.json"))["version"])')"
DMG_DIR="$ROOT/src-tauri/target/release/bundle/dmg"
mkdir -p "$DMG_DIR"
DMG="$DMG_DIR/Grok Build_${VERSION}_aarch64.dmg"
rm -f "$DMG"
hdiutil create -volname "Grok Build" -srcfolder "$APP" -ov -format UDZO "$DMG"
echo "Signed app: $APP"
echo "DMG: $DMG"
