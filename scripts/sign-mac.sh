#!/bin/bash
# Signs a built Cube.app the same way every time, so macOS keeps treating every build as the
# same app and a permission given to Cube once is not asked for again after a rebuild.
#
# There are two identities it can sign with:
#
# - An Apple Development certificate, when the login keychain has one (Xcode > Settings >
#   Accounts > Manage Certificates makes one, free). This is the one to have on a computer where
#   Cube is rebuilt often. The Keychain remembers "Always Allow" across rebuilds only for an app
#   signed with a certificate Apple issued, because it knows that app by its team.
# - This computer's local identity (scripts/setup-signing.sh: two files under ~/.cube-signing,
#   no keychain and no system setting touched), made on the first run along with the signing
#   tool. Screen Recording stays granted across rebuilds with it. The Keychain does not: it
#   knows such an app only by each build's own hash, so every rebuild is asked again for every
#   secret Cube saved (Slack tokens, the team key, model keys).
#
# CUBE_SIGN_WITH=local keeps to the local identity even when there is an Apple one. A disk image
# for teammates is signed that way: every image must come from one identity, and an Apple
# Development certificate carries its owner's name. Changing identity makes Cube a new app to
# macOS once: Screen Recording and each saved secret are asked for one more time.
# Set CUBE_NO_SIGN=1 to leave a build as it is.
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

# The first Apple Development certificate that is still valid, by its hash, or nothing.
apple_identity() {
  [ "${CUBE_SIGN_WITH:-}" = "local" ] && return 0
  security find-identity -v -p codesigning 2>/dev/null | awk '/"Apple Development: /{print $2; exit}'
}

APPLE="$(apple_identity || true)"
if [ -n "$APPLE" ]; then
  # codesign takes the key from the login keychain, which asks once whether it may ("Always Allow").
  # No timestamp, for the reason given below.
  if ! codesign --force --sign "$APPLE" --timestamp=none "$APP" >/dev/null 2>&1; then
    echo "sign-mac: signing with the Apple Development certificate failed:" >&2
    codesign --force --sign "$APPLE" --timestamp=none "$APP" 2>&1 | tail -5 >&2 || true
    echo "sign-mac: CUBE_SIGN_WITH=local signs with the local identity instead. The build is left as it was." >&2
    exit 1
  fi
  codesign --verify --deep --strict "$APP"
  # What the Keychain goes by. Without a team it would fall back to the build's hash.
  TEAM="$(codesign -dv "$APP" 2>&1 | sed -n 's/^TeamIdentifier=//p')"
  if [ -z "$TEAM" ] || [ "$TEAM" = "not set" ]; then
    echo "sign-mac: the build was signed, but carries no team: the Keychain will ask again after every rebuild" >&2
    exit 1
  fi
  echo "sign-mac: signed $(basename "$APP") with the Apple Development certificate (team $TEAM)"
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
if [ "${CUBE_SIGN_WITH:-}" != "local" ]; then
  echo "sign-mac: the Keychain will ask for Cube's saved secrets again after this rebuild. An Apple Development certificate stops that (see the top of scripts/sign-mac.sh)."
fi
