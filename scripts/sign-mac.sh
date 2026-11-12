#!/bin/bash
# Signs a built Cube.app with this computer's local signing identity, so macOS keeps treating
# every build as the same app and a permission given to Cube once (Screen Recording, the
# Keychain) is not asked for again after a rebuild or an update.
#
# The first run on a computer makes the identity (scripts/setup-signing.sh: two files under
# ~/.cube-signing, no keychain and no system setting touched) and installs the signing tool.
# From then on it only signs. Set CUBE_NO_SIGN=1 to leave a build as it is.
set -euo pipefail

APP="${1:-src-tauri/target/debug/bundle/macos/Cube.app}"
DIR="$HOME/.cube-signing"
HERE="$(cd "$(dirname "$0")" && pwd)"
export PATH="$HOME/.cargo/bin:$PATH"

if [ ! -d "$APP" ]; then
  echo "sign-mac: no app at $APP" >&2
  exit 1
fi
if [ "${CUBE_NO_SIGN:-}" = "1" ]; then
  echo "sign-mac: CUBE_NO_SIGN is set. The build stays signed ad hoc, and macOS will ask for its permissions again after every rebuild."
  exit 0
fi
if [ ! -f "$DIR/key.pem" ] || [ ! -f "$DIR/cert.pem" ]; then
  bash "$HERE/setup-signing.sh"
fi
if ! command -v rcodesign >/dev/null; then
  echo "sign-mac: installing the signing tool, once (cargo install apple-codesign). This takes a few minutes."
  cargo install apple-codesign --locked >/dev/null 2>&1 \
    || { echo "sign-mac: could not install rcodesign. Run 'cargo install apple-codesign --locked' and build again; until then the build is signed ad hoc and macOS will ask for its permissions after every rebuild." >&2; exit 1; }
fi

# No timestamp server: the certificate is this computer's own, so a timestamp proves nothing, and
# asking for one made signing fail whenever Apple's server could not be reached. A build left
# unsigned that way is a different app to macOS, which then asks for every permission again.
sign() {
  rcodesign sign --pem-file "$DIR/key.pem" --pem-file "$DIR/cert.pem" --timestamp-url none --binary-identifier app.cube.desktop "$APP"
}
sign >/dev/null 2>&1 || { echo "sign-mac: signing failed" >&2; sign 2>&1 | tail -5 >&2; exit 1; }
codesign --verify --deep "$APP"
# What macOS will know the app by. If it is not the local identity, say so instead of passing.
if ! codesign -dr - "$APP" 2>&1 | grep -q "certificate root"; then
  echo "sign-mac: the build is not signed with the local identity" >&2
  exit 1
fi
echo "sign-mac: signed $(basename "$APP") with the local identity"
