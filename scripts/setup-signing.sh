#!/bin/bash
# Makes a signing identity for local builds of Cube, once.
#
# macOS ties permissions such as Screen Recording to how an app is signed. A build signed "ad hoc"
# looks like a different app after every rebuild, so the permission is lost each time. Signing with
# one certificate that stays the same makes every build count as the same app.
#
# The certificate is self-signed and only meaningful on this computer. It and its key are two
# files under ~/.cube-signing, readable by you alone. No keychain and no system setting is
# touched, and nothing here goes into the repository. Signing is done by rcodesign, which works
# from those files (install it with: cargo install apple-codesign --locked).
set -euo pipefail

DIR="$HOME/.cube-signing"
NAME="Cube Local Signing"

if [ -f "$DIR/key.pem" ] && [ -f "$DIR/cert.pem" ]; then
  echo "Signing identity already set up in $DIR"
  exit 0
fi

mkdir -p "$DIR"
chmod 700 "$DIR"
umask 077
CONF="$(mktemp)"
trap 'rm -f "$CONF"' EXIT

cat > "$CONF" <<CONF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = $NAME
[ext]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
CONF

/usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -config "$CONF" -keyout "$DIR/key.pem" -out "$DIR/cert.pem" 2>/dev/null
chmod 600 "$DIR/key.pem" "$DIR/cert.pem"
echo "Made the signing identity \"$NAME\" in $DIR"
