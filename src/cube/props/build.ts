/**
 * What a cube holds or wears, and what it does with it. Each prop is a few small pictures (made
 * to match the cubes: the same glossy, rounded look) and a few plain marks (a line being
 * written, a bubble, the flash of a blow), with a two-second motion that shows the tool in use.
 * Two things are made from that one description: a Lottie animation, played while the cube is
 * at work, and a still picture of the pose it rests in, for a cube that is idle and for the
 * many small cubes beside past messages. Both come from the same numbers, so they cannot drift
 * apart.
 *
 * Everything is placed in a square of 120 units. The cube's own picture takes the middle 100,
 * and the 10 around it are room for a hat above or a tool held out to the side.
 */

export const BOX = 120;
/** Frames in one loop, and how many play in a second: every motion is two seconds and ends where it began. */
export const FRAMES = 60;
export const RATE = 30;
/** The pictures are squares of this many pixels. */
export const PIXELS = 256;

interface Paint {
  fill?: string;
  /** The line's color. No line when unset. */
  stroke?: string;
  /** The line's width, in units. */
  width?: number;
}

export type Shape =
  | ({ kind: "rect"; x: number; y: number; w: number; h: number; r?: number } & Paint)
  | ({ kind: "ellipse"; cx: number; cy: number; rx: number; ry: number } & Paint)
  | ({ kind: "path"; points: [number, number][]; closed?: boolean } & Paint);

export const rect = (x: number, y: number, w: number, h: number, paint: Paint & { r?: number } = {}): Shape => ({ kind: "rect", x, y, w, h, ...paint });
export const ellipse = (cx: number, cy: number, rx: number, ry: number, paint: Paint = {}): Shape => ({ kind: "ellipse", cx, cy, rx, ry, ...paint });
/** A filled outline through the points, closed. */
export const poly = (points: [number, number][], paint: Paint = {}): Shape => ({ kind: "path", points, closed: true, ...paint });
/** A line through the points, left open and not filled. */
export const line = (points: [number, number][], stroke: string, width = 3): Shape => ({ kind: "path", points, closed: false, stroke, width });
/** Points along part of a circle, for a line that curves: from one angle to another, in degrees clockwise from the right. */
export function arc(cx: number, cy: number, r: number, from: number, to: number, steps = 8): [number, number][] {
  return Array.from({ length: steps + 1 }, (_, n) => {
    const a = ((from + ((to - from) * n) / steps) * Math.PI) / 180;
    return [Math.round((cx + r * Math.cos(a)) * 100) / 100, Math.round((cy + r * Math.sin(a)) * 100) / 100] as [number, number];
  });
}

/** A value at a frame. The first key is the pose at rest, and the last must repeat it so the loop closes. */
export type Key = [frame: number, value: number];
export type Key2 = [frame: number, x: number, y: number];

interface Motion {
  name: string;
  /** Where its pivot sits in the square. Turning and growing are about this point. */
  at: [number, number];
  /** Turned by this many degrees, clockwise. */
  rotate?: Key[];
  /** Moved by this much from `at`. */
  move?: Key2[];
  /** Scaled to this many percent, across and down. */
  scale?: Key2[];
  /** How visible it is, in percent. */
  fade?: Key[];
  /** Drawn behind the cube and not over it: the cube covers what of it is on its far side. */
  behind?: boolean;
}

/** A prop is drawn in two goes: what is behind the cube, then, over the cube, what is in front of it. */
export type Layer = "front" | "behind";
const inLayer = (p: Motion, layer: Layer): boolean => Boolean(p.behind) === (layer === "behind");
/** True when some part of the prop goes behind the cube. */
export const hasBehind = (def: PropDef): boolean => def.pieces.some((p) => p.behind);

/** One picture that moves as a whole: a pencil, a book, a hat. */
export interface Picture extends Motion {
  /** Where the picture is loaded from. */
  image: string;
  /** How wide and tall it is drawn, in units. */
  size: number;
  /** The point of the picture that sits at `at`, as fractions of its width and height. The middle when unset. */
  pivot?: [number, number];
}

/** Plain marks that show the tool doing something: the line a pencil leaves, the sound out of a megaphone. */
export interface Marks extends Motion {
  /** The marks, the one underneath first, in coordinates of their own about `at`. */
  shapes: Shape[];
  /** How much of each line is drawn, in percent from its start: a line that is written as it goes. */
  draw?: Key[];
}

export type Piece = Picture | Marks;
const isPicture = (p: Piece): p is Picture => "image" in p;

export interface PropDef {
  /** The parts, the one underneath first. */
  pieces: Piece[];
}

const rgb = (hex: string): [number, number, number] => {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  return [0, 2, 4].map((i) => Math.round((parseInt(full.slice(i, i + 2), 16) / 255) * 1000) / 1000) as [number, number, number];
};

// ---- Lottie ---------------------------------------------------------------------------------

const still = (k: number | number[]) => ({ a: 0, k });
/** Keys that ease in and out of every pose: nothing a cube does starts or stops abruptly. */
function keyed(keys: number[][]): { a: 1; k: object[] } {
  return {
    a: 1,
    k: keys.map(([t, ...s], n) => (n === keys.length - 1 ? { t, s } : { t, s, o: { x: [0.4], y: [0] }, i: { x: [0.6], y: [1] } })),
  };
}

function shapeItems(s: Shape): object[] {
  const items: object[] = [];
  if (s.kind === "rect") items.push({ ty: "rc", d: 1, p: still([s.x + s.w / 2, s.y + s.h / 2]), s: still([s.w, s.h]), r: still(s.r ?? 0) });
  else if (s.kind === "ellipse") items.push({ ty: "el", d: 1, p: still([s.cx, s.cy]), s: still([s.rx * 2, s.ry * 2]) });
  else items.push({ ty: "sh", ks: still({ c: Boolean(s.closed), v: s.points, i: s.points.map(() => [0, 0]), o: s.points.map(() => [0, 0]) } as unknown as number) });
  if (s.stroke) items.push({ ty: "st", c: still([...rgb(s.stroke), 1]), o: still(100), w: still(s.width ?? 3), lc: 2, lj: 2 });
  if (s.fill) items.push({ ty: "fl", c: still([...rgb(s.fill), 1]), o: still(100), r: 1 });
  items.push({ ty: "tr", p: still([0, 0]), a: still([0, 0]), s: still([100, 100]), r: still(0), o: still(100) });
  return items;
}

/** How a part is placed and moved, in Lottie's terms. `unit` is what 100 percent of its own size comes to. */
function transform(p: Motion, anchor: [number, number], unit: number): object {
  return {
    o: p.fade ? keyed(p.fade) : still(100),
    r: p.rotate ? keyed(p.rotate) : still(0),
    p: p.move ? keyed(p.move.map(([t, x, y]) => [t, p.at[0] + x, p.at[1] + y, 0])) : still([p.at[0], p.at[1], 0]),
    a: still([anchor[0], anchor[1], 0]),
    s: p.scale ? keyed(p.scale.map(([t, x, y]) => [t, (unit * x) / 100, (unit * y) / 100, 100])) : still([unit, unit, 100]),
  };
}

/** The prop as a Lottie animation: one layer per part, looping. */
export function toLottie(def: PropDef, name = "prop", layer: Layer = "front"): object {
  const assets: object[] = [];
  const layers = def.pieces.filter((p) => inLayer(p, layer)).map((p, n) => {
    const common = { ddd: 0, ind: n + 1, nm: p.name, sr: 1, ao: 0, ip: 0, op: FRAMES, st: 0, bm: 0 };
    if (isPicture(p)) {
      const id = `image_${assets.length}`;
      // `e: 1` has the player take the address as it is, not as a file beside the animation.
      assets.push({ id, w: PIXELS, h: PIXELS, u: "", p: p.image, e: 1 });
      const [px, py] = p.pivot ?? [0.5, 0.5];
      return { ...common, ty: 2, refId: id, ks: transform(p, [px * PIXELS, py * PIXELS], (p.size / PIXELS) * 100) };
    }
    // Within a layer Lottie draws its first shape on top. A trim after the shapes applies to all of them.
    const shapes: object[] = [...p.shapes].reverse().map((s, i) => ({ ty: "gr", nm: `${s.kind} ${i + 1}`, it: shapeItems(s) }));
    if (p.draw) shapes.push({ ty: "tm", nm: "draw", s: still(0), e: keyed(p.draw), o: still(0), m: 1 });
    return { ...common, ty: 4, ks: transform(p, [0, 0], 100), shapes };
  });
  // Lottie draws its first layer on top.
  return { v: "5.7.4", fr: RATE, ip: 0, op: FRAMES, w: BOX, h: BOX, nm: name, ddd: 0, assets, layers: layers.reverse() };
}

// ---- Still picture --------------------------------------------------------------------------

const num = (n: number) => String(Math.round(n * 100) / 100);

function shapeSvg(s: Shape): string {
  const paint = `fill="${s.fill ?? "none"}" ${s.stroke ? `stroke="${s.stroke}" stroke-width="${num(s.width ?? 3)}" stroke-linecap="round" stroke-linejoin="round"` : `stroke="none"`}`;
  if (s.kind === "rect") return `<rect x="${num(s.x)}" y="${num(s.y)}" width="${num(s.w)}" height="${num(s.h)}" rx="${num(Math.min(s.r ?? 0, s.w / 2, s.h / 2))}" ${paint}/>`;
  if (s.kind === "ellipse") return `<ellipse cx="${num(s.cx)}" cy="${num(s.cy)}" rx="${num(s.rx)}" ry="${num(s.ry)}" ${paint}/>`;
  return `<path d="M${s.points.map(([x, y]) => `${num(x)} ${num(y)}`).join("L")}${s.closed ? "Z" : ""}" ${paint}/>`;
}

/**
 * The prop in the pose its motion starts from, as the inside of an SVG picture whose viewBox is
 * the 120 square. Parts that start out hidden or not yet drawn are left out.
 */
export function toSvg(def: PropDef, layer: Layer = "front"): string {
  return def.pieces
    .filter((p) => inLayer(p, layer) && (p.fade?.[0]?.[1] ?? 100) > 0 && (isPicture(p) || (p.draw?.[0]?.[1] ?? 100) > 0))
    .map((p) => {
      const [dx, dy] = p.move?.[0] ? [p.move[0][1], p.move[0][2]] : [0, 0];
      const turn = p.rotate?.[0]?.[1] ?? 0;
      const [sx, sy] = p.scale?.[0] ? [p.scale[0][1] / 100, p.scale[0][2] / 100] : [1, 1];
      const fade = p.fade?.[0]?.[1] ?? 100;
      const place = `translate(${num(p.at[0] + dx)} ${num(p.at[1] + dy)})${turn ? ` rotate(${num(turn)})` : ""}${sx !== 1 || sy !== 1 ? ` scale(${num(sx)} ${num(sy)})` : ""}`;
      const [px, py] = isPicture(p) ? (p.pivot ?? [0.5, 0.5]) : [0, 0];
      const inside = isPicture(p)
        ? `<image href="${p.image}" x="${num(-px * p.size)}" y="${num(-py * p.size)}" width="${num(p.size)}" height="${num(p.size)}"/>`
        : p.shapes.map(shapeSvg).join("");
      return `<g transform="${place}"${fade < 100 ? ` opacity="${num(fade / 100)}"` : ""}>${inside}</g>`;
    })
    .join("");
}
