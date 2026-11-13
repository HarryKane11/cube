#!/bin/bash
# Packs a signed Cube.app as what the app's own updater downloads, and writes the note that
# tells every copy of Cube which version is the newest and where to get it.
#
#   update-bundle.sh <Cube.app> <out dir>   writes Cube_universal.app.tar.gz and latest.json
#   update-bundle.sh --check                only checks that this computer can sign updates
#
# Both files go onto the GitHub release next to the disk image. A copy of Cube reads
# latest.json from the latest release (the address is in src-tauri/tauri.conf.json), and when
# the version in it is newer than its own it downloads the archive, checks the signature
# against the key built into it, replaces itself and restarts.
#
# The archive is made here, from the app as scripts/sign-mac.sh signed it, and not by
# `tauri build`: that would pack the app before it is signed, and an update would then swap in
# an app macOS takes for a different one, and ask for every permission again.
#
# The signature also carries the version, and the app refuses an archive whose signed version
# is not the one latest.json announces, so an old archive cannot be passed off as a new one.
set -euo pipefail

cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$PATH"
KEY="$HOME/.cube-signing/updater.key"
CONF="src-tauri/tauri.conf.json"

# The key on this computer has to be the one built into the app, or no copy of Cube would
# accept what it signs.
if [ ! -f "$KEY" ] || [ ! -f "$KEY.pub" ]; then
  echo "update-bundle: there is no update signing key in ~/.cube-signing." >&2
  echo "update-bundle: releases are made on the computer that holds it (or a copy of it). scripts/setup-updater-key.sh makes a new one, but then no copy of Cube people already have can update itself." >&2
  exit 1
fi
BUILT_IN="$(node -p "require('./$CONF').plugins.updater.pubkey")"
if [ "$BUILT_IN" != "$(tr -d '\n' < "$KEY.pub")" ]; then
  echo "update-bundle: the update signing key in ~/.cube-signing is not the one in $CONF (plugins.updater.pubkey), so Cube would refuse this update." >&2
  exit 1
fi
if [ "${1:-}" = "--check" ]; then
  echo "update-bundle: this computer can sign updates"
  exit 0
fi

APP="${1:?usage: update-bundle.sh <Cube.app> <out dir>}"
OUT="${2:?usage: update-bundle.sh <Cube.app> <out dir>}"
if [ ! -d "$APP" ]; then
  echo "update-bundle: no app at $APP" >&2
  exit 1
fi
# An update must be the same app to macOS as the one it replaces.
if ! codesign --verify --deep "$APP" 2>/dev/null || ! codesign -dr - "$APP" 2>&1 | grep -q "certificate root"; then
  echo "update-bundle: $APP is not signed with the local identity. Sign it first (CUBE_SIGN_WITH=local scripts/sign-mac.sh)." >&2
  exit 1
fi

# The version the app inside calls itself, so the note can never announce another.
PLIST="$APP/Contents/Info.plist"
VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$PLIST")"
BINARY="$APP/Contents/MacOS/$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$PLIST")"
ARCHS="$(lipo -archs "$BINARY")"

mkdir -p "$OUT"
TGZ="$OUT/Cube_universal.app.tar.gz"
rm -f "$TGZ" "$TGZ.sig" "$OUT/latest.json"
# Only the app's files. Finder's own attributes are not part of what was signed.
COPYFILE_DISABLE=1 tar --no-xattrs --no-mac-metadata -czf "$TGZ" -C "$(dirname "$APP")" "$(basename "$APP")"
pnpm -s tauri signer sign -f "$KEY" -p "" --app-version "$VERSION" "$TGZ" >/dev/null 2>&1 \
  || { echo "update-bundle: could not sign the update" >&2; exit 1; }

VERSION="$VERSION" ARCHS="$ARCHS" SIG="$TGZ.sig" NOTES="${CUBE_RELEASE_NOTES:-}" node - "$CONF" "$OUT/latest.json" <<'JS'
const fs = require("fs");
const [conf, out] = process.argv.slice(2);
const { VERSION, ARCHS, SIG, NOTES } = process.env;
// The archive sits on the release for this version, in the repository the app asks.
const endpoint = JSON.parse(fs.readFileSync(conf, "utf8")).plugins.updater.endpoints[0];
const repo = endpoint.replace(/\/releases\/latest\/download\/[^/]+$/, "");
if (repo === endpoint) throw new Error(`update-bundle: cannot tell the repository from ${endpoint}`);
const entry = { signature: fs.readFileSync(SIG, "utf8").trim(), url: `${repo}/releases/download/v${VERSION}/Cube_universal.app.tar.gz` };
// One entry for each kind of Mac the app inside runs on.
const names = { arm64: "darwin-aarch64", x86_64: "darwin-x86_64" };
const platforms = Object.fromEntries(ARCHS.split(/\s+/).filter((a) => names[a]).map((a) => [names[a], entry]));
if (!Object.keys(platforms).length) throw new Error(`update-bundle: the app runs on no Mac this knows (${ARCHS})`);
fs.writeFileSync(out, JSON.stringify({ version: VERSION, notes: NOTES, pub_date: new Date().toISOString(), platforms }, null, 2) + "\n");
JS
# The signature is inside latest.json; the loose file is not published.
rm -f "$TGZ.sig"

echo "update-bundle: $TGZ"
echo "update-bundle: $OUT/latest.json (Cube $VERSION for $ARCHS)"
