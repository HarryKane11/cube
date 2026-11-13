#!/bin/bash
# Makes the key that signs Cube's updates, once.
#
# Cube updates itself from inside the app: it downloads the next version and replaces itself.
# Before it does, it checks that the download was signed with this key, so that nobody else can
# hand people an "update". This is a different key from the one that signs the app for macOS
# (scripts/setup-signing.sh): that one tells macOS which app this is, this one tells Cube that
# an update comes from whoever makes Cube.
#
# The key is two files under ~/.cube-signing, readable by you alone, with no password (like the
# app's signing key beside it). The public half is written into src-tauri/tauri.conf.json
# (plugins.updater.pubkey) and so is built into every copy of Cube.
#
# Keep the private half safe and backed up. Without it no update can be signed, and the copies
# of Cube people already have can never update themselves again: they would have to download a
# new disk image by hand. A new key means a new public half in tauri.conf.json, which only
# reaches people through such a download.
set -euo pipefail

cd "$(dirname "$0")/.."
DIR="$HOME/.cube-signing"
KEY="$DIR/updater.key"

if [ -f "$KEY" ] && [ -f "$KEY.pub" ]; then
  echo "Update signing key already set up in $DIR"
  exit 0
fi

mkdir -p "$DIR"
chmod 700 "$DIR"
umask 077
pnpm -s tauri signer generate --ci -w "$KEY" >/dev/null
chmod 600 "$KEY" "$KEY.pub"
echo "Made the update signing key in $DIR"
echo "Put its public half into src-tauri/tauri.conf.json, as plugins.updater.pubkey:"
cat "$KEY.pub"
echo
