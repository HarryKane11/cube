#!/bin/bash
# Builds Cube for both kinds of Mac (Apple silicon and Intel) and packs it as a disk image to
# hand to teammates.
#
# The app inside is signed with this computer's local signing identity (~/.cube-signing), the
# same one every build here is signed with. macOS ties a permission to how an app is signed, so
# as long as every disk image comes from the same identity, a teammate gives Cube Screen
# Recording and Keychain access once and is not asked again when they install a newer one.
# Keep ~/.cube-signing safe: an image signed with another identity is a new app to macOS.
#
# The certificate is self-signed, so macOS still asks a teammate to confirm the first time they
# open the app (System Settings > Privacy & Security > Open Anyway). Only a paid Apple Developer
# ID removes that.
set -euo pipefail

cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$PATH"

if [ "${CUBE_NO_SIGN:-}" = "1" ]; then
  echo "dmg-mac: a disk image is only made signed, so teammates are asked for permissions once. Unset CUBE_NO_SIGN." >&2
  exit 1
fi

pnpm tauri build --target universal-apple-darwin --bundles app
APP="src-tauri/target/universal-apple-darwin/release/bundle/macos/Cube.app"
bash scripts/sign-mac.sh "$APP"

VERSION="$(node -p "require('./src-tauri/tauri.conf.json').version")"
OUT="src-tauri/target/universal-apple-darwin/release/bundle/dmg"
DMG="$OUT/Cube_${VERSION}_universal.dmg"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$OUT"
# ditto keeps the signature and everything it covers exactly as signed.
ditto "$APP" "$STAGE/Cube.app"
ln -s /Applications "$STAGE/Applications"
rm -f "$DMG"
hdiutil create -volname "Cube" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null

# The same image under a name that does not change from version to version, with its checksum:
# these are the two files a release carries, and what the README's download link points at.
cp -f "$DMG" "$OUT/Cube_universal.dmg"
(cd "$OUT" && shasum -a 256 Cube_universal.dmg > Cube_universal.dmg.sha256)

echo "dmg-mac: $DMG"
echo "dmg-mac: $OUT/Cube_universal.dmg (+ .sha256), for a release"
echo "dmg-mac: signed as $(codesign -dr - "$APP" 2>&1 | sed -n 's/^designated => //p')"
