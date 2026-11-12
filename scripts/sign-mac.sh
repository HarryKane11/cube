#!/bin/bash
# Signs the built Cube.app with the local signing identity, so macOS keeps treating rebuilds as
# the same app and permissions given to Cube (Screen Recording, the Keychain) survive them.
# Without the identity or the signing tool it says so and leaves the build as it is.
set -euo pipefail

APP="${1:-src-tauri/target/debug/bundle/macos/Cube.app}"
DIR="$HOME/.cube-signing"
export PATH="$HOME/.cargo/bin:$PATH"

if [ ! -d "$APP" ]; then
  echo "sign-mac: no app at $APP" >&2
  exit 1
fi
if [ ! -f "$DIR/key.pem" ] || [ ! -f "$DIR/cert.pem" ]; then
  echo "sign-mac: no local signing identity. Run scripts/setup-signing.sh once to keep macOS permissions across builds."
  exit 0
fi
if ! command -v rcodesign >/dev/null; then
  echo "sign-mac: rcodesign is not installed (cargo install apple-codesign --locked). The build stays signed ad hoc."
  exit 0
fi

rcodesign sign --pem-file "$DIR/key.pem" --pem-file "$DIR/cert.pem" --binary-identifier app.cube.desktop "$APP" >/dev/null 2>&1 \
  || { echo "sign-mac: signing failed" >&2; rcodesign sign --pem-file "$DIR/key.pem" --pem-file "$DIR/cert.pem" --binary-identifier app.cube.desktop "$APP" 2>&1 | tail -5 >&2; exit 1; }
codesign --verify --deep "$APP"
echo "sign-mac: signed $(basename "$APP") with the local identity"
