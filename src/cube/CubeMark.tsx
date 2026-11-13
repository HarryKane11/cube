import { useEffect, useId, useState } from "react";
import { useCube } from "../state/store";

/**
 * Cube's mark: a cube seen from a corner, drawn flat. It stands for the app itself and for Cube,
 * the member of the team who is always there (the logo in the sidebar, the picture on Home, its
 * face beside what it says), where the colored, moving cubes stand for the other agents.
 *
 * As it comes it is one color, the color of the text around it: black on a light background,
 * white on a dark one. The person can give it a look of their own (a gradient across it, a
 * figure on its front) so it is told apart from the rest at a glance.
 *
 * The same numbers draw the app's icon (scripts/icon/mark.py), which keeps the plain look:
 * change them in both places.
 */

/** The cube's corners in a square of 100 that the faces are drawn from, and the one in the middle. The lower right one follows from the rest. */
const TOP: [number, number] = [50, 7];
const RIGHT_UP: [number, number] = [87.2, 28.5];
const BOTTOM: [number, number] = [50, 93];
const LEFT_DOWN: [number, number] = [12.8, 71.5];
const LEFT_UP: [number, number] = [12.8, 28.5];
const MIDDLE: [number, number] = [50, 50];

/** How much of a tile's side is left open as the line between tiles. */
const GAP = 0.085;

type Point = [number, number];

/**
 * The nine tiles of one face: a corner of the face, and the two edges that leave it. Tile
 * `row * 3 + col` is `col` steps along the first edge and `row` steps along the second.
 */
function tiles(from: Point, across: Point, down: Point): string[] {
  const u: Point = [(across[0] - from[0]) / 3, (across[1] - from[1]) / 3];
  const v: Point = [(down[0] - from[0]) / 3, (down[1] - from[1]) / 3];
  const at = (i: number, j: number): string => `${(from[0] + u[0] * i + v[0] * j).toFixed(2)} ${(from[1] + u[1] * i + v[1] * j).toFixed(2)}`;
  const out: string[] = [];
  for (let j = 0; j < 3; j++) {
    for (let i = 0; i < 3; i++) {
      const [a, b] = [GAP, 1 - GAP];
      out.push(`M${at(i + a, j + a)}L${at(i + b, j + a)}L${at(i + b, j + b)}L${at(i + a, j + b)}Z`);
    }
  }
  return out;
}

/** The three faces that show, top, right and left, with how dark each is drawn: the light comes from above. */
const TOP_FACE = 0;
const RIGHT_FACE = 1;
const LEFT_FACE = 2;
const SHADES = [0.3, 0.62, 1];
const TILES: string[][] = [tiles(LEFT_UP, TOP, MIDDLE), tiles(MIDDLE, RIGHT_UP, BOTTOM), tiles(LEFT_UP, MIDDLE, LEFT_DOWN)];

// ---- The look the person gave it --------------------------------------------------------------

/** What the cube is filled with: the text's own color, or a gradient that runs across it. */
export const FILLS: { id: string; name: string; stops?: [string, string, string] }[] = [
  { id: "mono", name: "Black and white" },
  { id: "sunset", name: "Sunset", stops: ["#ffb347", "#ff6b6b", "#c44dff"] },
  { id: "ocean", name: "Ocean", stops: ["#5eead4", "#3b9bff", "#4f46e5"] },
  { id: "mint", name: "Mint", stops: ["#d9f99d", "#34d399", "#0d9488"] },
  { id: "grape", name: "Grape", stops: ["#f0abfc", "#a855f7", "#4c1d95"] },
  { id: "ember", name: "Ember", stops: ["#fde047", "#fb923c", "#dc2626"] },
  { id: "steel", name: "Steel", stops: ["#e5e7eb", "#94a3b8", "#334155"] },
];

const circle = (cx: number, cy: number, r: number) => `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${r * 2} 0a${r} ${r} 0 1 0 ${-r * 2} 0Z`;
const STAR = Array.from({ length: 10 }, (_, i) => {
  const r = i % 2 ? 0.19 : 0.46;
  const a = (i * Math.PI) / 5 - Math.PI / 2;
  return `${i ? "L" : "M"}${(0.5 + r * Math.cos(a)).toFixed(3)} ${(0.52 + r * Math.sin(a)).toFixed(3)}`;
}).join("") + "Z";

/** A figure on the cube's front, drawn in a square of 1 by 1. */
export const SYMBOLS: { id: string; name: string; d: string }[] = [
  { id: "bolt", name: "Lightning", d: "M0.6 0.06L0.2 0.56H0.45L0.38 0.94L0.8 0.42H0.55Z" },
  { id: "heart", name: "Heart", d: "M0.5 0.88C0.18 0.63 0.1 0.46 0.1 0.33C0.1 0.2 0.2 0.11 0.31 0.11C0.39 0.11 0.46 0.16 0.5 0.24C0.54 0.16 0.61 0.11 0.69 0.11C0.8 0.11 0.9 0.2 0.9 0.33C0.9 0.46 0.82 0.63 0.5 0.88Z" },
  { id: "spade", name: "Spade", d: "M0.5 0.08C0.82 0.33 0.9 0.5 0.9 0.62C0.9 0.74 0.8 0.82 0.7 0.82C0.63 0.82 0.57 0.79 0.53 0.74L0.61 0.94H0.39L0.47 0.74C0.43 0.79 0.37 0.82 0.3 0.82C0.2 0.82 0.1 0.74 0.1 0.62C0.1 0.5 0.18 0.33 0.5 0.08Z" },
  { id: "club", name: "Club", d: `${circle(0.5, 0.29, 0.19)}${circle(0.29, 0.58, 0.19)}${circle(0.71, 0.58, 0.19)}M0.46 0.56L0.38 0.94H0.62L0.54 0.56Z` },
  { id: "diamond", name: "Diamond", d: "M0.5 0.06L0.86 0.5L0.5 0.94L0.14 0.5Z" },
  { id: "star", name: "Star", d: STAR },
];

/** How the mark is drawn: what fills it, and the figure on its front, if any. Both are ids from the lists above. */
export interface CubeLook {
  /** Drawn as the flat mark, or as a cube that turns like the other cubes. The mark when unset. */
  shape?: "mark" | "cube";
  /** One of FILLS, or CUSTOM_FILL for the person's own `colors`. */
  fill?: string;
  /** The person's own colors, one for each face that shows: front, top, side. Used when `fill` is CUSTOM_FILL. */
  colors?: [string, string, string];
  symbol?: string;
  /** The figure once across the front, or on every tile. Across the front when unset. */
  spread?: "face" | "tiles";
}

/** The fill that is not in the list: three colors the person picked themselves, one a face. */
export const CUSTOM_FILL = "custom";
/** What the pickers start from, before the person has picked: front, top, side. */
export const FIRST_COLORS: [string, string, string] = ["#3b82f6", "#93c5fd", "#1d4ed8"];

/** Each face as the corner it is drawn from and the two corners its edges lead to, in the order of TILES. */
const FRAMES: [Point, Point, Point][] = [[LEFT_UP, TOP, MIDDLE], [MIDDLE, RIGHT_UP, BOTTOM], [LEFT_UP, MIDDLE, LEFT_DOWN]];

/** Puts a drawing made in a square of 1 by 1 onto a face, or onto one of its nine tiles, a little in from the edges. */
function onto([from, across, down]: [Point, Point, Point], tile?: [number, number]): string {
  const k = tile ? 3 : 1;
  const u: Point = [(across[0] - from[0]) / k, (across[1] - from[1]) / k];
  const v: Point = [(down[0] - from[0]) / k, (down[1] - from[1]) / k];
  const [i, j] = tile ?? [0, 0];
  return `matrix(${u[0]} ${u[1]} ${v[0]} ${v[1]} ${from[0] + u[0] * i + v[0] * j} ${from[1] + u[1] * i + v[1] * j}) translate(0.17 0.17) scale(0.66)`;
}
const ON_FRONT = onto(FRAMES[LEFT_FACE]);
const ON_TILES: string[] = FRAMES.flatMap((frame) => Array.from({ length: 9 }, (_, n) => onto(frame, [n % 3, Math.floor(n / 3)])));

/** The look in use: the one handed in (to show a choice before it is made), else the person's own. */
function useLook(given?: CubeLook): { stops?: [string, string, string]; faces?: [string, string, string]; symbol?: string; tiles: boolean } {
  const own = useCube((s) => s.settings.cubeLook);
  const look = given ?? own;
  const picked = look?.fill === CUSTOM_FILL ? look.colors : undefined;
  return {
    stops: FILLS.find((f) => f.id === look?.fill)?.stops,
    // In the order the faces are drawn: top, right (the side), left (the front).
    faces: picked ? [picked[1], picked[2], picked[0]] : undefined,
    symbol: SYMBOLS.find((x) => x.id === look?.symbol)?.d,
    tiles: look?.spread === "tiles",
  };
}

/** The gradient a look fills the cube with, from its top corner down to the bottom one. */
function Gradient({ id, stops }: { id: string; stops: [string, string, string] }) {
  return (
    <defs>
      <linearGradient id={id} gradientUnits="userSpaceOnUse" x1="20" y1="10" x2="80" y2="92">
        <stop offset="0" stopColor={stops[0]} />
        <stop offset="0.5" stopColor={stops[1]} />
        <stop offset="1" stopColor={stops[2]} />
      </linearGradient>
    </defs>
  );
}

/**
 * The figure, once across the front or on every tile: the background's color on a plain cube,
 * so it reads as cut out of it; white on a colored one.
 */
function Figure({ d, colored, tiles }: { d: string; colored: boolean; tiles: boolean }) {
  const paint = { fill: colored ? "#ffffff" : "var(--background)", opacity: colored ? 0.94 : 1 };
  if (!tiles) return <path d={d} transform={ON_FRONT} {...paint} />;
  return <>{ON_TILES.map((t, i) => <path key={i} d={d} transform={t} {...paint} />)}</>;
}

export function CubeMark({ size, className, title, look: given, plain }: { size: number; className?: string; title?: string; look?: CubeLook; /** Leaves the figure off: at the size of a logo it is only specks. */ plain?: boolean }) {
  const { stops, faces, symbol, tiles } = useLook(given);
  const id = useId();
  const paint = stops ? `url(#${id})` : "currentColor";
  return (
    <svg viewBox="0 0 100 100" width={size} height={size} className={className} role={title ? "img" : undefined} aria-label={title} aria-hidden={title ? undefined : true}>
      {stops && <Gradient id={id} stops={stops} />}
      {TILES.map((face, f) => (
        // A colored cube keeps its color on every face and is only shaded a little; a plain one is three tones of one color.
        // One with the person's own colors has each face in its color, as it is.
        <path key={f} d={face.join("")} fill={faces?.[f] ?? paint} stroke={faces?.[f] ?? paint} strokeWidth={1.6} strokeLinejoin="round" opacity={faces ? 1 : stops ? [0.72, 0.88, 1][f] : SHADES[f]} />
      ))}
      {symbol && !plain && <Figure d={symbol} colored={Boolean(stops || faces)} tiles={tiles} />}
    </svg>
  );
}

// ---- The mark being solved --------------------------------------------------------------------

/** Which shade each of the 27 tiles has: an index into SHADES, face by face. Solved, every tile has its face's own. */
type Tiles = number[];
const at = (face: number, row: number, col: number) => face * 9 + row * 3 + col;
const any = () => Math.floor(Math.random() * SHADES.length);

/** A cube with its shades all over the place. */
export function scrambled(): Tiles {
  return Array.from({ length: 27 }, any);
}

/**
 * One turn of a layer, as it looks from this corner: a row of three goes from one face onto
 * the next, and three tiles from the sides that do not show come into view behind it.
 * `layer` picks which of the nine layers that can be seen turning (three each way).
 */
export function turned(tiles: Tiles, layer: number, incoming: [number, number, number] = [any(), any(), any()]): Tiles {
  const next = [...tiles];
  const n = layer % 3;
  if (layer < 3) {
    // A flat layer turns to the right: the left face's row goes onto the right face.
    for (let c = 0; c < 3; c++) {
      next[at(RIGHT_FACE, n, c)] = tiles[at(LEFT_FACE, n, c)];
      next[at(LEFT_FACE, n, c)] = incoming[c];
    }
  } else if (layer < 6) {
    // An upright layer turns toward the viewer on the left: a row of the top comes down the left face.
    for (let r = 0; r < 3; r++) {
      next[at(LEFT_FACE, r, n)] = tiles[at(TOP_FACE, n, 2 - r)];
      next[at(TOP_FACE, n, 2 - r)] = incoming[r];
    }
  } else {
    // And one on the right: a column of the top comes down the right face.
    for (let r = 0; r < 3; r++) {
      next[at(RIGHT_FACE, r, n)] = tiles[at(TOP_FACE, r, n)];
      next[at(TOP_FACE, r, n)] = incoming[r];
    }
  }
  return next;
}

/** How often a layer turns while the cube is being solved, in milliseconds. */
const TURN_EVERY = 190;

/**
 * The mark as a cube being solved: its layers turn, shades changing places, for as long as
 * `colors` is not given. Once it is (front, top, side: a cube's own colors), every tile takes
 * its face's color, one after another, and the cube is solved in that cube's colors.
 */
export function SolvingMark({ size, colors, solved, className, title }: { size: number; colors?: readonly [string, string, string]; /** Solved without colors: every tile back in its face's own shade, as in the mark at rest. */ solved?: boolean; className?: string; title?: string }) {
  const [shades, setShades] = useState<Tiles>(scrambled);
  const { stops, faces, symbol, tiles } = useLook();
  const id = useId();
  const done = Boolean(colors) || Boolean(solved);
  useEffect(() => {
    if (done) return;
    const timer = window.setInterval(() => setShades((s) => turned(s, Math.floor(Math.random() * 9))), TURN_EVERY);
    return () => window.clearInterval(timer);
  }, [done]);
  // Which of a cube's three colors each face takes: its front is the face toward the viewer on the left.
  const colorOf = colors ? [colors[1], colors[2], colors[0]] : undefined;
  const own = stops ? `url(#${id})` : "currentColor";
  return (
    <svg viewBox="0 0 100 100" width={size} height={size} className={className} role={title ? "img" : undefined} aria-label={title} aria-hidden={title ? undefined : true}>
      {stops && !colorOf && <Gradient id={id} stops={stops} />}
      {TILES.map((face, f) =>
        face.map((d, k) => {
          const color = colorOf?.[f] ?? faces?.[f] ?? own;
          return (
            <path
              key={`${f}-${k}`}
              d={d}
              fill={color}
              stroke={color}
              strokeWidth={1.6}
              strokeLinejoin="round"
              opacity={colorOf ? 1 : solved ? (faces ? 1 : stops ? [0.72, 0.88, 1][f] : SHADES[f]) : SHADES[shades[f * 9 + k]]}
              // Turning, a tile changes at once with its row. Solved, the color runs across the cube tile by tile.
              style={{ transition: done ? "fill 220ms ease, stroke 220ms ease, opacity 220ms ease" : "opacity 150ms ease", transitionDelay: done ? `${(f * 9 + k) * 16}ms` : undefined }}
            />
          );
        }),
      )}
      {/* The figure comes back with the cube's own look, once it is solved without another cube's colors. */}
      {symbol && solved && !colorOf && <Figure d={symbol} colored={Boolean(stops || faces)} tiles={tiles} />}
    </svg>
  );
}
