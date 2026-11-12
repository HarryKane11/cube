#!/bin/bash
# Takes the README's pictures: the browser preview filled with a made-up team (seed.js), in
# English and Korean, light and dark, plus each role's cube with a clear background.
#
#   pnpm dev                      # in another terminal
#   bash scripts/readme/shoot.sh  # writes docs/readme/
#
# Needs agent-browser and cwebp. LANGS, THEMES and SCENES narrow what is taken.
set -euo pipefail
cd "$(dirname "$0")/../.."

URL="${URL:-http://localhost:1420}"
OUT="docs/readme"
LANGS="${LANGS:-en ko}"
THEMES="${THEMES:-light dark}"
SCENES="${SCENES:-home work shared invite}"
export AGENT_BROWSER_SESSION="cube-readme"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"; agent-browser close >/dev/null 2>&1 || true' EXIT

agent-browser open "$URL" >/dev/null
# Twice the pixels, so the pictures stay sharp on a retina screen.
agent-browser set viewport 1400 940 2 >/dev/null
agent-browser wait 1500 >/dev/null

for lang in $LANGS; do
  mkdir -p "$OUT/$lang"
  for theme in $THEMES; do
    for scene in $SCENES; do
      # The home screen is shorter than a conversation: less empty room under it.
      if [ "$scene" = "home" ]; then agent-browser set viewport 1400 700 2 >/dev/null; else agent-browser set viewport 1400 940 2 >/dev/null; fi
      agent-browser eval "$(cat scripts/readme/seed.js); window.__seed('$lang','$theme','$scene').catch((e) => console.error(e)); 'ok'" >/dev/null
      agent-browser wait 2200 >/dev/null
      agent-browser screenshot "$TMP/$scene.png" >/dev/null
      cwebp -quiet -q 90 "$TMP/$scene.png" -o "$OUT/$lang/$scene-$theme.webp"
      if [ "$scene" = "invite" ]; then agent-browser press Escape >/dev/null; fi
      echo "shoot: $OUT/$lang/$scene-$theme.webp"
    done
  done
done

mkdir -p "$OUT/cubes"
agent-browser eval "window.__cubes().then((v) => { window.__cubesOut = v; }); 'ok'" >/dev/null
agent-browser wait 800 >/dev/null
agent-browser eval "window.__cubesOut" > "$TMP/cubes.json"
python3 - "$TMP/cubes.json" "$OUT/cubes" <<'PY'
import base64, json, sys
raw = open(sys.argv[1]).read().strip()
cubes = json.loads(raw)
if isinstance(cubes, str):
    cubes = json.loads(cubes)
for cube in cubes:
    data = cube["url"].split(",", 1)[1]
    open(f"{sys.argv[2]}/{cube['name']}.png", "wb").write(base64.b64decode(data))
    print(f"shoot: {sys.argv[2]}/{cube['name']}.png")
PY
