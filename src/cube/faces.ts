import type { Status } from "../agents/types";

/** The faces a cube can make. Two plain dark ovals; only their shape and place change. */
export type Expr = "open" | "blink" | "up" | "side" | "focus" | "wide" | "flat" | "happy" | "dead";

export const FACE_W = 512;
export const FACE_H = 320;

const INK = "#1E1B3A";
const RX = 31;
const RY = 47;
const DX = 80;
const CY = 160;
const TAU = Math.PI * 2;

type G = CanvasRenderingContext2D;

function oval(g: G, x: number, y: number, rx: number, ry: number): void {
  g.beginPath();
  g.ellipse(x, y, rx, ry, 0, 0, TAU);
  g.fill();
}

/** Draws both eyes. `lx`/`ly` in -1..1 nudge the gaze a little, the same way in both eyes. */
export function drawFace(g: G, expr: Expr, lx: number, ly: number): void {
  g.clearRect(0, 0, FACE_W, FACE_H);
  g.fillStyle = INK;
  g.strokeStyle = INK;
  g.lineCap = "round";
  g.lineJoin = "round";
  for (const side of [-1, 1]) {
    const cx = FACE_W / 2 + side * DX;
    switch (expr) {
      case "open":
        oval(g, cx + lx * 10, CY + ly * 8, RX, RY);
        break;
      case "blink":
        oval(g, cx, CY + 4, RX * 1.05, 6);
        break;
      case "up":
        oval(g, cx + lx * 14, CY - 18, RX, RY * 0.9);
        break;
      case "side":
        oval(g, cx - 20, CY, RX, RY);
        break;
      case "focus":
        oval(g, cx + lx * 16, CY + 6, RX * 1.05, RY * 0.6);
        break;
      case "wide":
        oval(g, cx, CY - 4, RX * 1.25, RY * 1.2);
        break;
      case "flat":
        g.lineWidth = 15;
        g.beginPath();
        g.moveTo(cx - 26, CY);
        g.lineTo(cx + 26, CY);
        g.stroke();
        break;
      case "happy":
        g.lineWidth = 16;
        g.beginPath();
        g.arc(cx, CY + 16, 30, Math.PI * 1.1, Math.PI * 1.9);
        g.stroke();
        break;
      case "dead":
        g.lineWidth = 14;
        g.beginPath();
        g.moveTo(cx - 22, CY - 22); g.lineTo(cx + 22, CY + 22);
        g.moveTo(cx + 22, CY - 22); g.lineTo(cx - 22, CY + 22);
        g.stroke();
        break;
    }
  }
}

/** Which face a cube shows for a status at time `t`. `seed` keeps cubes from moving in lockstep. */
export function exprFor(status: Status, t: number, seed: number): Expr {
  const u = t + seed * 7.3;
  switch (status) {
    case "idle":
      if (u % 9.5 > 8.3) return "side";
      return u % 4.1 < 0.14 ? "blink" : "open";
    case "thinking":
      return u % 6.4 < 4.4 ? "up" : "side";
    case "working":
      return u % 5.2 < 0.14 ? "blink" : "focus";
    case "needs":
      return "wide";
    case "stuck":
      return u % 5 < 3.4 ? "dead" : "flat";
    case "done":
      return "happy";
  }
}
