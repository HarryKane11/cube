"""Cuts the far side off a prop that is worn around a cube, so the rest can be drawn in front of it.

A headset goes around the cube's head: the ear cup on the far side, and the band where it comes
down to it, are behind the cube. Cube draws the whole picture behind the cube and this cut of it
in front, so the cube covers what is on its far side (see `behind` in src/cube/props/build.ts).

    uv run --with pillow python scripts/props/near_side.py src/assets/props/headset.png src/assets/props/headset-near.png

What is kept, in pixels of the 256 square: everything right of CUP_CUT, and above V_CUT also
what is right of BAND_CUT (the band, up to where it goes over the cube's far edge).
"""
import sys

from PIL import Image

BAND_CUT = 62
CUP_CUT = 98
V_CUT = 104


def main(src: str, dst: str) -> None:
    picture = Image.open(src).convert("RGBA")
    pixels = picture.load()
    width, height = picture.size
    for v in range(height):
        for u in range(width):
            kept = u >= CUP_CUT or (u >= BAND_CUT and v < V_CUT)
            if not kept:
                r, g, b, _ = pixels[u, v]
                pixels[u, v] = (r, g, b, 0)
    picture.save(dst)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
