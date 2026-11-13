/**
 * The catalog of what a cube can hold or wear to show what it does, and how it uses it: one
 * that writes draws a line with a pencil, one that looks things up turns the pages of a book,
 * one that knows the law brings a gavel down on the code. The motion plays while the cube is at
 * work, at the same time as its layers twist. When a sub-agent is set up, the program that
 * writes its definition picks the entry that fits (see agents/setup.ts), and the person can
 * pick another.
 *
 * Each is placed so that it never covers the cube's eyes for long: a tool at the lower right, a
 * hat on top. The cube's own picture is the middle 100 of the 120 square (see build.ts).
 */
import baton from "@/assets/props/baton.png";
import beret from "@/assets/props/beret.png";
import books from "@/assets/props/books.png";
import brush from "@/assets/props/brush.png";
import calculator from "@/assets/props/calculator.png";
import camera from "@/assets/props/camera.png";
import chart from "@/assets/props/chart.png";
import flask from "@/assets/props/flask.png";
import gavel from "@/assets/props/gavel.png";
import globe from "@/assets/props/globe.png";
import goggles from "@/assets/props/goggles.png";
import headset from "@/assets/props/headset.png";
import headsetNear from "@/assets/props/headset-near.png";
import lawbook from "@/assets/props/lawbook.png";
import magnifier from "@/assets/props/magnifier.png";
import megaphone from "@/assets/props/megaphone.png";
import openbook from "@/assets/props/openbook.png";
import pencil from "@/assets/props/pencil.png";
import shield from "@/assets/props/shield.png";
import wrench from "@/assets/props/wrench.png";
import { arc, ellipse, line, poly, rect, type Key, type Key2, type Piece, type PropDef } from "./build";

export interface PropEntry {
  id: string;
  /** What it is called in the picker. Interface text, in English. */
  name: string;
  /** What kind of work it stands for, in a few words: what the program setting a sub-agent up picks by. */
  about: string;
  /** The picture it is known by in the picker. */
  icon: string;
  def: PropDef;
}

// Colors for the marks, chosen to show on a light and on a dark background alike.
const GRAPHITE = "#8a8a93";
const PURPLE = "#a43cf0";
const YELLOW = "#ffc233";
const BLUE = "#3b9bff";
const GREEN = "#3ccf4e";
const CORAL = "#ff5a3c";
const PAPER = "#f6e2c0";
const PAPER_EDGE = "#d7b98a";

/** Shown from one frame to another, coming in and going out over a few frames, and hidden the rest of the loop. */
const shown = (from: number, to: number, soft = 4): Key[] => [[0, 0], ...(from > 0 ? [[from, 0] as Key] : []), [from + soft, 100], [to - soft, 100], [to, 0], ...(to < 60 ? [[60, 0] as Key] : [])];

/** A zigzag of `steps` strokes, each `dx` across and `dy` up: handwriting, seen small. */
const scribble = (steps: number, dx: number, dy: number): [number, number][] => Array.from({ length: steps + 1 }, (_, n) => [n * dx, n % 2 ? -dy : 0] as [number, number]);

// A pencil writes a line: its tip goes along as the line appears behind it, then it comes back for the next.
const WRITE_STEPS = 8;
const writer: PropDef = {
  pieces: [
    {
      name: "line",
      at: [58, 110],
      shapes: [line(scribble(WRITE_STEPS, 3.5, 2.6), GRAPHITE, 2.6)],
      draw: Array.from({ length: WRITE_STEPS + 1 }, (_, n) => [n * 5, (n * 100) / WRITE_STEPS] as Key).concat([[60, 100]]),
      fade: [[0, 100], [44, 100], [56, 0], [60, 0]],
    },
    {
      name: "pencil",
      image: pencil,
      size: 42,
      pivot: [0.5, 0.955],
      at: [58, 110],
      rotate: [[0, 22], [10, 28], [20, 22], [30, 28], [40, 22], [60, 22]],
      move: [...scribble(WRITE_STEPS, 3.5, 2.6).map(([x, y], n) => [n * 5, x, y] as [number, number, number]), [48, 28, -5], [60, 0, 0]],
    },
  ],
};

// A page of the open book is turned, twice, in front of the stack still to be read.
const page = (from: number): Piece => ({
  name: `page ${from}`,
  at: [82, 99],
  shapes: [poly([[0, -8.5], [15.5, -10], [15.5, 3.5], [0, 5]], { fill: PAPER, stroke: PAPER_EDGE, width: 1.2 })],
  scale: [[0, 100, 100], [from, 100, 100], [from + 16, -100, 100], [60, -100, 100]],
  fade: shown(from - 2, from + 18, 2),
});
const reader: PropDef = {
  pieces: [
    { name: "stack", image: books, size: 30, at: [101, 80], rotate: [[0, 6], [60, 6]] },
    { name: "open book", image: openbook, size: 44, at: [82, 100], move: [[0, 0, 0], [14, 0, -1.5], [30, 0, 0], [44, 0, -1.5], [60, 0, 0]] },
    page(6),
    page(36),
  ],
};

// A brush lays down a stroke of paint under a painter's beret.
const STROKE: [number, number][] = [[0, 0], [7, -3], [15, -4], [23, -2.5], [30, 1]];
const painter: PropDef = {
  pieces: [
    { name: "paint", at: [62, 108], shapes: [line(STROKE, PURPLE, 6)], draw: [[0, 0], [6, 0], [34, 100], [60, 100]], fade: [[0, 100], [44, 100], [56, 0], [60, 0]] },
    {
      name: "brush",
      image: brush,
      size: 44,
      pivot: [0.5, 0.94],
      at: [62, 107],
      rotate: [[0, 30], [6, 34], [20, 24], [34, 16], [46, 30], [60, 30]],
      move: [[0, 0, -6], [6, 0, 0], [13, 7, -3], [20, 15, -4], [27, 23, -2.5], [34, 30, 1], [46, 20, -8], [60, 0, -6]],
    },
    { name: "beret", image: beret, size: 44, at: [53, 21], rotate: [[0, -8], [30, -4], [60, -8]], move: [[0, 0, 0], [30, 0, -1.5], [60, 0, 0]] },
  ],
};

// A magnifying glass goes over the cube, stopping to look closer.
const reviewer: PropDef = {
  pieces: [
    {
      name: "glass",
      image: magnifier,
      size: 44,
      pivot: [0.42, 0.42],
      at: [86, 86],
      rotate: [[0, 0], [16, -8], [36, 6], [60, 0]],
      move: [[0, 0, 0], [16, -20, -4], [24, -20, -4], [38, -6, -22], [46, -6, -22], [60, 0, 0]],
      scale: [[0, 100, 100], [16, 100, 100], [20, 114, 114], [24, 100, 100], [38, 100, 100], [42, 114, 114], [46, 100, 100], [60, 100, 100]],
    },
    { name: "found", at: [62, 70], shapes: [line([[0, -5], [0, 5]], YELLOW, 2.4), line([[-5, 0], [5, 0]], YELLOW, 2.4)], fade: shown(16, 26, 3), scale: [[0, 50, 50], [16, 50, 50], [21, 120, 120], [26, 60, 60], [60, 60, 60]] },
  ],
};

// A gavel comes down on the book of law.
const HIT = 26;
const judge: PropDef = {
  pieces: [
    { name: "law book", image: lawbook, size: 38, at: [64, 121], pivot: [0.5, 1], scale: [[0, 100, 100], [HIT - 1, 100, 100], [HIT + 2, 104, 90], [HIT + 8, 100, 100], [60, 100, 100]] },
    { name: "blow", at: [66, 86], shapes: [line([[-13, -3], [-19, -8]], YELLOW, 2.6), line([[0, -7], [0, -14]], YELLOW, 2.6), line([[13, -3], [19, -8]], YELLOW, 2.6)], fade: shown(HIT - 1, HIT + 12, 3) },
    { name: "gavel", image: gavel, size: 50, pivot: [0.5, 0.95], at: [105, 108], rotate: [[0, -20], [16, 10], [HIT, -56], [HIT + 8, -56], [48, -20], [60, -20]] },
  ],
};

// A flask is swirled and bubbles, under safety glasses pushed up on the forehead.
const bubble = (x: number, r: number, from: number): Piece => ({
  name: `bubble ${from}`,
  at: [x, 70],
  shapes: [ellipse(0, 0, r, r, { fill: GREEN })],
  move: [[0, 0, 0], [from, 0, 0], [from + 22, x > 90 ? 3 : -3, -18], [60, x > 90 ? 3 : -3, -18]],
  fade: shown(from, from + 22),
});
const scientist: PropDef = {
  pieces: [
    { name: "flask", image: flask, size: 44, pivot: [0.5, 0.92], at: [90, 108], rotate: [[0, 0], [12, -9], [30, 9], [48, -6], [60, 0]] },
    bubble(88, 2.6, 4),
    bubble(93, 1.9, 22),
    bubble(89, 2.2, 36),
    { name: "goggles", image: goggles, size: 46, at: [43, 41], rotate: [[0, 5], [60, 5]] },
  ],
};

// A wrench turns a bolt: a quick pull, then back for the next.
const TURN: Key[] = [[0, -30], [14, 26], [22, 26], [46, -30], [60, -30]];
const builder: PropDef = {
  pieces: [
    { name: "bolt", at: [86, 76], shapes: [poly(arc(0, 0, 5.2, 0, 300, 5), { fill: "#d5dae2", stroke: "#8b93a1", width: 1.4 })], rotate: [[0, 0], [14, 56], [60, 56]] },
    { name: "wrench", image: wrench, size: 48, pivot: [0.5, 0.2], at: [86, 76], rotate: TURN },
    { name: "tight", at: [100, 66], shapes: [line([[0, 0], [5, -4]], YELLOW, 2.4), line([[2, 6], [8, 5]], YELLOW, 2.4)], fade: shown(12, 24, 3) },
  ],
};

// A headset is worn, and someone is on the line.
const wave = (r: number, from: number): Piece => ({ name: `wave ${from}`, at: [66, 95], shapes: [line(arc(0, 0, r, -50, 50, 6), BLUE, 2.4)], fade: shown(from, from + 20) });
const NOD: Key2[] = [[0, 0, 0], [30, 0, -1.2], [60, 0, 0]];
const operator: PropDef = {
  pieces: [
    // Worn around the cube: the whole headset is behind it, so the cube covers the ear cup on its far side,
    // and the near side (the other cup, the band over the top, the microphone) is drawn again in front.
    { name: "headset far side", image: headset, size: 120, at: [59, 56], move: NOD, behind: true },
    { name: "headset", image: headsetNear, size: 120, at: [59, 56], move: NOD },
    wave(5, 6),
    wave(10, 14),
    wave(5, 36),
    wave(10, 44),
  ],
};

// A baton beats time, and the notes come.
const note = (x: number, y: number, from: number, color: string): Piece => ({
  name: `note ${from}`,
  at: [x, y],
  shapes: [ellipse(0, 0, 3, 2.3, { fill: color }), line([[2.6, 0], [2.6, -9]], color, 1.6)],
  move: [[0, 0, 0], [from, 0, 0], [from + 20, 2, -10], [60, 2, -10]],
  fade: shown(from, from + 20),
});
const conductor: PropDef = {
  pieces: [
    note(70, 66, 8, YELLOW),
    note(108, 60, 32, BLUE),
    { name: "baton", image: baton, size: 50, pivot: [0.5, 0.92], at: [92, 110], rotate: [[0, 28], [12, -16], [24, 22], [36, -10], [48, 26], [60, 28]] },
  ],
};

// A line of where things are heading is drawn across a chart.
const analyst: PropDef = {
  pieces: [
    { name: "chart", image: chart, size: 42, at: [88, 92], scale: [[0, 100, 100], [34, 100, 100], [40, 108, 108], [48, 100, 100], [60, 100, 100]] },
    { name: "trend", at: [88, 92], shapes: [line([[-14, 2], [-6, -4], [1, -1], [13, -14]], CORAL, 2.8), line([[7, -14], [13, -14], [13, -8]], CORAL, 2.8)], draw: [[0, 0], [6, 0], [34, 100], [60, 100]], fade: [[0, 100], [46, 100], [56, 0], [60, 0]] },
  ],
};

// A megaphone calls out, twice.
const sound = (r: number, from: number): Piece => ({ name: `sound ${from}`, at: [100, 80], shapes: [line(arc(0, 0, r, -62, 28, 6), CORAL, 2.4)], fade: shown(from, from + 18) });
const announcer: PropDef = {
  pieces: [
    { name: "megaphone", image: megaphone, size: 44, pivot: [0.3, 0.5], at: [78, 90], rotate: [[0, -14], [60, -14]], scale: [[0, 100, 100], [8, 110, 110], [20, 100, 100], [32, 100, 100], [38, 110, 110], [50, 100, 100], [60, 100, 100]] },
    sound(8, 4),
    sound(14, 10),
    sound(8, 34),
    sound(14, 40),
  ],
};

// Something goes round the world.
const ORBIT: [number, number, number][] = Array.from({ length: 9 }, (_, n) => [Math.round((n * 60) / 8), Math.round(Math.cos((n / 8) * 2 * Math.PI) * 23 * 10) / 10 - 23, Math.round(Math.sin((n / 8) * 2 * Math.PI) * 8 * 10) / 10] as [number, number, number]);
const translator: PropDef = {
  pieces: [
    { name: "globe", image: globe, size: 40, at: [88, 90], rotate: [[0, -6], [30, 6], [60, -6]] },
    { name: "path", at: [88, 90], shapes: [ellipse(0, 0, 23, 8, { stroke: YELLOW, width: 1.4 })], rotate: [[0, -18], [60, -18]], fade: shown(2, 58, 6) },
    { name: "messenger", at: [88, 90], shapes: [ellipse(23, 0, 3.2, 3.2, { fill: YELLOW, stroke: "#ffffff", width: 1.2 })], rotate: [[0, -18], [60, -18]], move: ORBIT },
  ],
};

// A shield holds, and what it guards is safe a little further out each time.
const guard: PropDef = {
  pieces: [
    { name: "ring", at: [88, 90], shapes: [ellipse(0, 0, 20, 20, { stroke: GREEN, width: 2.2 })], scale: [[0, 70, 70], [6, 70, 70], [36, 135, 135], [60, 135, 135]], fade: [[0, 0], [6, 0], [12, 90], [36, 0], [60, 0]] },
    { name: "shield", image: shield, size: 42, at: [88, 90], scale: [[0, 100, 100], [8, 110, 110], [20, 100, 100], [60, 100, 100]] },
  ],
};

// A camera is pointed, and the flash goes off.
const SNAP = 26;
const photographer: PropDef = {
  pieces: [
    { name: "camera", image: camera, size: 44, at: [86, 92], rotate: [[0, -4], [16, 5], [SNAP, 5], [44, -4], [60, -4]], scale: [[0, 100, 100], [SNAP - 2, 100, 100], [SNAP + 1, 102, 94], [SNAP + 6, 100, 100], [60, 100, 100]] },
    { name: "flash", at: [100, 72], shapes: [line([[0, -9], [0, 9]], YELLOW, 3), line([[-9, 0], [9, 0]], YELLOW, 3), line([[-5, -5], [5, 5]], "#ffffff", 2), line([[-5, 5], [5, -5]], "#ffffff", 2)], fade: shown(SNAP - 1, SNAP + 12, 3), scale: [[0, 50, 50], [SNAP - 1, 50, 50], [SNAP + 4, 125, 125], [SNAP + 12, 70, 70], [60, 70, 70]] },
  ],
};

// A calculator's keys are pressed, and the sums come out of it.
const key = (x: number, y: number, from: number): Piece => ({ name: `key ${from}`, at: [x, y], shapes: [rect(-3, -3, 6, 6, { r: 3, fill: "#ffffff" })], fade: shown(from, from + 9, 3) });
const sum = (shapes: ReturnType<typeof line>[], x: number, from: number): Piece => ({ name: `sum ${from}`, at: [x, 70], shapes, move: [[0, 0, 0], [from, 0, 0], [from + 20, 3, -9], [60, 3, -9]], fade: shown(from, from + 20) });
const accountant: PropDef = {
  pieces: [
    { name: "calculator", image: calculator, size: 44, at: [88, 91], rotate: [[0, -5], [30, 1], [60, -5]] },
    key(84, 92, 4),
    key(91, 98, 16),
    key(86, 103, 30),
    key(93, 91, 42),
    sum([line([[-4, 0], [4, 0]], BLUE, 2.4), line([[0, -4], [0, 4]], BLUE, 2.4)], 104, 8),
    sum([line([[-4, -2], [4, -2]], CORAL, 2.4), line([[-4, 2], [4, 2]], CORAL, 2.4)], 106, 34),
  ],
};

/** Everything a cube can be given, in the order the picker shows it. */
export const PROPS: PropEntry[] = [
  { id: "pencil", icon: pencil, name: "Pencil", about: "writes: drafts, documents, copy, editing", def: writer },
  { id: "books", icon: books, name: "Books", about: "looks things up: research, sources, reading, fact finding", def: reader },
  { id: "paint", icon: brush, name: "Beret and brush", about: "designs: visuals, illustration, brand, interface design", def: painter },
  { id: "magnifier", icon: magnifier, name: "Magnifying glass", about: "checks work: review, QA, testing, proofreading, audits", def: reviewer },
  { id: "gavel", icon: gavel, name: "Gavel and law book", about: "knows the rules: legal, contracts, compliance, policy", def: judge },
  { id: "flask", icon: flask, name: "Flask and goggles", about: "runs experiments: science, lab work, benchmarks, evaluation", def: scientist },
  { id: "wrench", icon: wrench, name: "Wrench", about: "builds and fixes: engineering, code, infrastructure, deployment", def: builder },
  { id: "headset", icon: headset, name: "Headset", about: "takes requests: support, front desk, routing, assistance", def: operator },
  { id: "baton", icon: baton, name: "Conductor's baton", about: "leads others: planning, coordination, project management", def: conductor },
  { id: "chart", icon: chart, name: "Chart", about: "works with numbers: data analysis, metrics, reports", def: analyst },
  { id: "megaphone", icon: megaphone, name: "Megaphone", about: "gets the word out: marketing, announcements, social media, PR", def: announcer },
  { id: "globe", icon: globe, name: "Globe", about: "works across languages: translation, localization", def: translator },
  { id: "shield", icon: shield, name: "Shield", about: "keeps things safe: security, privacy, risk", def: guard },
  { id: "camera", icon: camera, name: "Camera", about: "works with pictures and film: photo, video, media", def: photographer },
  { id: "calculator", icon: calculator, name: "Calculator", about: "keeps the books: finance, accounting, budgets, pricing", def: accountant },
];

const BY_ID = new Map(PROPS.map((p) => [p.id, p]));
export const propById = (id: string | undefined): PropEntry | undefined => (id ? BY_ID.get(id) : undefined);

/** What each of the cubes that come with Cube holds. */
export const BUILT_IN_PROPS: Record<string, string> = {
  router: "headset",
  orchestrator: "baton",
  researcher: "books",
  writer: "pencil",
  builder: "wrench",
  designer: "paint",
  reviewer: "magnifier",
};
