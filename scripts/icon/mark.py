"""Draws Cube's mark (the cube of src/cube/CubeMark.tsx, each face in its own color) as pictures: the app's icon and the page's icon.

Usage: uv run --with pillow python scripts/icon/mark.py
Then, for the app's icon in every size:  pnpm tauri icon scripts/icon/app-icon.png

The numbers are the ones in CubeMark.tsx. Change them in both places.
"""
from pathlib import Path

from PIL import Image, ImageDraw

TOP, RIGHT_UP, BOTTOM, LEFT_DOWN, LEFT_UP, MIDDLE = (50, 7), (87.2, 28.5), (50, 93), (12.8, 71.5), (12.8, 28.5), (50, 50)
GAP = 0.085
# The logo's colors: the top, the side and the front of the cube.
YELLOW, BLUE, RED = (250, 204, 21), (37, 99, 235), (225, 29, 72)
# Each face: a corner, the two corners its edges lead to, and its color.
FACES = [(LEFT_UP, TOP, MIDDLE, YELLOW), (MIDDLE, RIGHT_UP, BOTTOM, BLUE), (LEFT_UP, MIDDLE, LEFT_DOWN, RED)]
OVER = 4  # Drawn this many times larger and shrunk, for smooth edges.


def mark(size: int) -> Image.Image:
    """The mark alone on a clear background, `size` pixels square."""
    big = size * OVER
    k = big / 100
    out = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    for corner, across, down, ink in FACES:
        layer = Image.new("RGBA", (big, big), (0, 0, 0, 0))
        draw = ImageDraw.Draw(layer)
        u = ((across[0] - corner[0]) / 3, (across[1] - corner[1]) / 3)
        v = ((down[0] - corner[0]) / 3, (down[1] - corner[1]) / 3)
        at = lambda i, j: ((corner[0] + u[0] * i + v[0] * j) * k, (corner[1] + u[1] * i + v[1] * j) * k)
        for j in range(3):
            for i in range(3):
                a, b = GAP, 1 - GAP
                tile = [at(i + a, j + a), at(i + b, j + a), at(i + b, j + b), at(i + a, j + b)]
                draw.polygon(tile, fill=(*ink, 255))
                # The same round corners the stroke gives the tiles on screen.
                draw.line(tile + [tile[0]], fill=(*ink, 255), width=round(1.6 * k), joint="curve")
        out.alpha_composite(layer)
    return out.resize((size, size), Image.LANCZOS)


def tile(size: int, box: float, radius: float, inner: float) -> Image.Image:
    """The mark on a white rounded square: `box` is the square's side, `inner` the mark's, as parts of the picture."""
    big = size * OVER
    out = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    side = box * big
    at = (big - side) / 2
    ImageDraw.Draw(out).rounded_rectangle([at, at, at + side, at + side], radius=radius * big, fill=(255, 255, 255, 255))
    out = out.resize((size, size), Image.LANCZOS)
    m = mark(round(size * inner))
    out.alpha_composite(m, ((size - m.width) // 2, (size - m.height) // 2))
    return out


if __name__ == "__main__":
    here = Path(__file__).resolve().parent
    root = here.parent.parent
    # macOS draws app icons as a rounded square that leaves a margin in a 1024 canvas.
    tile(1024, 824 / 1024, 185 / 1024, 0.76).save(here / "app-icon.png")
    # The page's icon fills its square: it is shown very small.
    tile(256, 1.0, 0.22, 0.9).save(root / "public" / "cube-icon.png", optimize=True)
    print("wrote", here / "app-icon.png", "and public/cube-icon.png")
