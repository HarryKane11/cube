import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { logLine } from "../agents/runner";
import { mosaicOf, paletteOf, type Status } from "../agents/types";
import { drawFace, exprFor, FACE_H, FACE_W, type Expr } from "./faces";

/**
 * Every cube on screen is drawn by one shared WebGL renderer and copied onto its own 2D canvas,
 * so the app can show many cubes without running out of WebGL contexts.
 */
const SIZE = 288;
const H = Math.PI / 2;
const TAU = Math.PI * 2;
const N = 3;
const GAP = 0.05;
const STEP = 1 + GAP;
const TOTAL = N + (N - 1) * GAP;
const AXES = ["x", "y", "z"] as const;
type Axis = (typeof AXES)[number];

interface Move { axis: Axis; idx: number; dir: number }
interface Grab { pivot: THREE.Group; layer: THREE.Mesh[] }

/** Set from Settings: when true, cubes keep their layers still while they work. */
export const motion = { calm: false };

function tint(hex: string, k: number): THREE.Color {
  return new THREE.Color(hex).lerp(new THREE.Color("#ffffff"), k);
}

export class CubeInst {
  want: Status;
  private state: Status = "idle";
  readonly scene = new THREE.Scene();
  private root = new THREE.Group();
  private cubies: THREE.Mesh[] = [];
  private faceCanvas = document.createElement("canvas");
  private faceTex: THREE.CanvasTexture;
  private faceMat: THREE.MeshBasicMaterial;
  private face: THREE.Mesh;
  private hist: Move[] = [];
  private mv: { m: Move; g: Grab; t: number; dur: number } | null = null;
  private stuck: Grab | null = null;
  private wait = 0.2;
  private phase: "scramble" | "solve" = "scramble";
  private enterT = 0;
  private rx = 0.3; private ry = -0.44; private rz = 0; private py = 0;
  private expr: Expr = "open";
  private swapT = -1;
  private seed = Math.random();
  private owned: { dispose(): void }[] = [];

  constructor(readonly target: HTMLCanvasElement | null, color: string, status: Status) {
    this.want = status;
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8a93a8, 2.4));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(3, 5, 6);
    const fill = new THREE.DirectionalLight(0xffffff, 0.8);
    fill.position.set(-5, 1, 3);
    this.scene.add(key, fill, this.root);
    this.root.scale.setScalar(2.45 / TOTAL);

    // A role's cube is a solved puzzle at rest: one color per face (front, top, side) on a dark
    // body. Work scrambles the colors across the faces, and finishing solves them back.
    // Any other color gets a plain cube in tints of itself.
    const pal = paletteOf(color);
    const bodyColor = pal ? new THREE.Color(pal[0]).lerp(new THREE.Color("#141418"), 0.74) : new THREE.Color(color);
    const body = new THREE.MeshStandardMaterial({ color: bodyColor, roughness: pal ? 0.55 : 0.85 });
    const geo = new RoundedBoxGeometry(1, 1, 1, 4, 0.16);
    const sticker = new RoundedBoxGeometry(0.8, 0.8, 0.05, 2, 0.02);
    const mat = (k: number) => new THREE.MeshStandardMaterial({ color: tint(color, k), roughness: 0.3 });
    const flat = (hex: string) => new THREE.MeshStandardMaterial({ color: new THREE.Color(hex), roughness: 0.38 });
    const front = pal ? flat(pal[0]) : mat(0.22), top = pal ? flat(pal[1]) : mat(0.6), sideM = pal ? flat(pal[2]) : mat(0.42);
    this.owned.push(body, geo, sticker, front, sideM, top);
    // A team cube has every teammate's color on it, mixed across all faces.
    const mix = mosaicOf(color)?.map(flat) ?? null;
    if (mix) this.owned.push(...mix);
    const of = (face: THREE.Material, x: number, y: number, z: number, k: number) => (mix ? mix[(x * 5 + y * 3 + z * 7 + k * 2) % mix.length] : face);
    const half = (N - 1) / 2;
    const o = 0.502;
    for (let x = 0; x < N; x++) for (let y = 0; y < N; y++) for (let z = 0; z < N; z++) {
      const c = new THREE.Mesh(geo, body);
      c.position.set((x - half) * STEP, (y - half) * STEP, (z - half) * STEP);
      const add = (m: THREE.Material, px: number, py: number, pz: number, rx: number, ry: number) => {
        const s = new THREE.Mesh(sticker, m);
        s.position.set(px, py, pz);
        s.rotation.set(rx, ry, 0);
        c.add(s);
      };
      if (z === N - 1) add(of(front, x, y, z, 0), 0, 0, o, 0, 0);
      if (z === 0) add(of(front, x, y, z, 1), 0, 0, -o, 0, 0);
      if (x === N - 1) add(of(sideM, x, y, z, 2), o, 0, 0, 0, H);
      if (x === 0) add(of(sideM, x, y, z, 3), -o, 0, 0, 0, H);
      if (y === N - 1) add(of(top, x, y, z, 4), 0, o, 0, H, 0);
      if (y === 0) add(of(top, x, y, z, 5), 0, -o, 0, H, 0);
      this.root.add(c);
      this.cubies.push(c);
    }

    // The face is one fixed layer in front of the cube. It never rides on the pieces.
    this.faceCanvas.width = FACE_W;
    this.faceCanvas.height = FACE_H;
    this.faceTex = new THREE.CanvasTexture(this.faceCanvas);
    this.faceTex.colorSpace = THREE.SRGBColorSpace;
    this.faceMat = new THREE.MeshBasicMaterial({ map: this.faceTex, transparent: true, depthTest: false, depthWrite: false });
    const plane = new THREE.PlaneGeometry(TOTAL * 1.04, (TOTAL * 1.04 * FACE_H) / FACE_W);
    this.face = new THREE.Mesh(plane, this.faceMat);
    this.face.position.set(0, TOTAL * 0.03, TOTAL / 2 + 0.06);
    this.face.renderOrder = 10;
    this.root.add(this.face);
    this.owned.push(this.faceTex, this.faceMat, plane);
    this.paint(0);
  }

  private paint(t: number): void {
    const g = this.faceCanvas.getContext("2d");
    if (!g) return;
    const u = t + this.seed * 5;
    const lx = this.state === "working" ? Math.sin(u * 2.2) : Math.sin(u * 0.6);
    const ly = this.state === "working" ? 0 : Math.sin(u * 0.43) * 0.7;
    drawFace(g, this.expr, lx, ly);
    this.faceTex.needsUpdate = true;
  }

  private grab(axis: Axis, idx: number): Grab {
    const v = (idx - (N - 1) / 2) * STEP;
    const pivot = new THREE.Group();
    this.root.add(pivot);
    const layer = this.cubies.filter((c) => Math.abs(c.position[axis] - v) < 0.01);
    layer.forEach((c) => pivot.attach(c));
    return { pivot, layer };
  }

  private release(g: Grab): void {
    g.pivot.updateMatrixWorld(true);
    const half = (N - 1) / 2;
    const snap = (v: number) => (Math.round(v / STEP + half) - half) * STEP;
    for (const c of g.layer) {
      this.root.attach(c);
      c.position.set(snap(c.position.x), snap(c.position.y), snap(c.position.z));
      c.rotation.set(Math.round(c.rotation.x / H) * H, Math.round(c.rotation.y / H) * H, Math.round(c.rotation.z / H) * H);
      c.scale.set(1, 1, 1);
    }
    this.root.remove(g.pivot);
  }

  private start(m: Move, dur: number): void {
    this.mv = { m, g: this.grab(m.axis, m.idx), t: 0, dur };
  }

  step(t: number, dt: number): void {
    if (this.mv) {
      const v = this.mv;
      v.t += dt;
      const p = Math.min(1, v.t / v.dur);
      const e = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
      v.g.pivot.rotation[v.m.axis] = v.m.dir * H * e;
      if (p >= 1) { this.release(v.g); this.mv = null; }
    } else if (this.state !== this.want) {
      // Solve back to a clean cube before changing what it does. This is the moment the
      // scrambled colors snap back into place when work finishes.
      const back = this.hist.pop();
      if (back) this.start({ ...back, dir: -back.dir }, 0.13);
      else {
        if (this.stuck) { this.stuck.pivot.rotation.y = 0; this.release(this.stuck); this.stuck = null; }
        this.state = this.want;
        this.enterT = t;
        this.wait = 0.2;
        this.phase = "scramble";
        if (this.state === "stuck") this.stuck = this.grab("y", N - 1);
      }
    } else if (this.wait > 0) {
      this.wait -= dt;
    } else if (motion.calm) {
      // Calm mode: no twisting, only the face and a gentle sway show that it is working.
    } else if (this.state === "working") {
      // Stay scrambled for as long as the work lasts: keep turning layers, and undo a couple of
      // turns now and then so the cube never gets more than a few moves away from solved.
      if (this.phase === "scramble") {
        const m: Move = { axis: AXES[Math.floor(Math.random() * 3)], idx: Math.floor(Math.random() * N), dir: Math.random() < 0.5 ? 1 : -1 };
        this.hist.push(m);
        this.start(m, 0.36);
        if (this.hist.length >= 7) this.phase = "solve";
      } else {
        const back = this.hist.pop();
        if (back) this.start({ ...back, dir: -back.dir }, 0.3);
        if (this.hist.length <= 4) this.phase = "scramble";
      }
      this.wait = 0.22;
    } else if (this.state === "thinking") {
      const back = this.hist.pop();
      if (back) this.start({ ...back, dir: -back.dir }, 0.9);
      else { const m: Move = { axis: "y", idx: N - 1, dir: 1 }; this.hist.push(m); this.start(m, 0.9); }
      this.wait = 1.5;
    }

    let bx = 0.3, by = -0.44, bz = 0, y = 0;
    const s = this.state;
    if (s === "idle") { y = Math.sin(t * 1.6 + this.seed * 6) * 0.05; by += Math.sin(t * 0.7 + this.seed * 6) * 0.06; }
    else if (s === "thinking") { by += Math.sin(t * 0.5) * 0.08; bx -= 0.06; }
    else if (s === "working") { by += Math.sin(t * 1.3) * 0.08; bz = Math.sin(t * 2.1) * 0.02; }
    else if (s === "needs") { y = Math.abs(Math.sin(t * 4.2)) * 0.22; by = -0.26; bx = 0.2; }
    else if (s === "stuck") { bz = Math.sin(t * 9) * 0.025; if (this.stuck) this.stuck.pivot.rotation.y = 0.5 + Math.sin(t * 5) * 0.07; }
    else { const sp = Math.min(1, (t - this.enterT) / 1.1); by += (1 - Math.pow(1 - sp, 3)) * TAU; y = Math.abs(Math.sin(t * 3)) * 0.06; }
    const k = Math.min(1, dt * 9);
    this.rx += (bx - this.rx) * k; this.ry += (by - this.ry) * k; this.rz += (bz - this.rz) * k; this.py += (y - this.py) * k;
    this.root.rotation.set(this.rx, this.ry, this.rz);
    this.root.position.y = this.py + 0.1;

    // A change of face is a quick squash: close, swap, pop open.
    const wantExpr = exprFor(this.want, t, this.seed);
    if (wantExpr !== this.expr && this.swapT < 0) this.swapT = t;
    let sy = 1;
    if (this.swapT >= 0) {
      const q = (t - this.swapT) / 0.18;
      if (q >= 0.5 && this.expr !== wantExpr) this.expr = wantExpr;
      sy = q < 0.5 ? 1 - q * 1.84 : q < 1 ? 0.08 + (q - 0.5) * 1.84 : 1;
      if (q >= 1) this.swapT = -1;
    }
    this.face.scale.y = sy;
    this.paint(t);
    this.root.updateMatrixWorld();
    FWD.set(0, 0, 1).applyQuaternion(this.root.quaternion);
    this.faceMat.opacity = Math.max(0, Math.min(1, (FWD.z - 0.25) / 0.25));
  }

  render(renderer: THREE.WebGLRenderer, cam: THREE.Camera, out: CanvasRenderingContext2D, w: number, h: number): void {
    renderer.render(this.scene, cam);
    out.clearRect(0, 0, w, h);
    out.drawImage(renderer.domElement, 0, 0, w, h);
  }

  dispose(): void {
    this.owned.forEach((o) => o.dispose());
  }
}

const FWD = new THREE.Vector3();

class Engine {
  private renderer: THREE.WebGLRenderer | null = null;
  private cam = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
  private items = new Set<CubeInst>();
  private raf = 0;
  private last = 0;
  private failed = false;
  private stills = new Map<string, string>();

  private ensure(): THREE.WebGLRenderer | null {
    if (this.renderer || this.failed) return this.renderer;
    try {
      const r = new THREE.WebGLRenderer({ alpha: true, antialias: true });
      r.setPixelRatio(1);
      r.setSize(SIZE, SIZE, false);
      this.cam.position.set(0, 0, 7.6);
      this.renderer = r;
    } catch {
      this.failed = true;
    }
    return this.renderer;
  }

  /** Returns null when WebGL is unavailable; the caller then shows a flat fallback. */
  add(canvas: HTMLCanvasElement, color: string, status: Status): CubeInst | null {
    if (!this.ensure()) return null;
    const inst = new CubeInst(canvas, color, status);
    this.items.add(inst);
    // Draw one frame right away, so a cube is never an empty box while animation frames are
    // paused (a window in the background gets none).
    const out = canvas.getContext("2d");
    const r = this.renderer;
    if (out && r) {
      try {
        inst.step(performance.now() / 1000, 0.016);
        inst.render(r, this.cam, out, canvas.width, canvas.height);
      } catch (e) {
        logLine(`cube: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (!this.raf) { this.last = performance.now(); this.raf = requestAnimationFrame(this.tick); }
    return inst;
  }

  remove(inst: CubeInst): void {
    this.items.delete(inst);
    inst.dispose();
    if (!this.items.size && this.raf) { cancelAnimationFrame(this.raf); this.raf = 0; }
  }

  /** One still frame of a resting cube, as an image URL. Used for avatars that do not need to move. */
  still(color: string): string | null {
    // The picture depends on the face colors too, which the person can change.
    const key = `${color}|${paletteOf(color)?.join() ?? ""}`;
    const cached = this.stills.get(key);
    if (cached) return cached;
    const r = this.ensure();
    if (!r) return null;
    const inst = new CubeInst(null, color, "idle");
    inst.step(0, 0.016);
    r.render(inst.scene, this.cam);
    const url = r.domElement.toDataURL("image/png");
    inst.dispose();
    this.stills.set(key, url);
    return url;
  }

  /**
   * One picture of a small scene someone else builds, drawn by the same renderer and camera as
   * the cubes so it sits beside them as one family. `build` fills the scene and returns how to
   * free what it made. Kept by `key`; null when WebGL is unavailable.
   */
  shot(key: string, build: (scene: THREE.Scene) => () => void): string | null {
    const cached = this.stills.get(key);
    if (cached) return cached;
    const r = this.ensure();
    if (!r) return null;
    const scene = new THREE.Scene();
    const free = build(scene);
    try {
      r.render(scene, this.cam);
      const url = r.domElement.toDataURL("image/png");
      this.stills.set(key, url);
      return url;
    } catch (e) {
      logLine(`cube icon: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    } finally {
      free();
    }
  }

  private tick = (now: number) => {
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    const r = this.renderer;
    if (r && !document.hidden) {
      for (const inst of this.items) {
        const c = inst.target;
        if (!c || !c.isConnected) continue;
        const out = c.getContext("2d");
        if (!out) continue;
        // One cube failing must not stop the others, or every cube made later stays blank.
        try {
          inst.step(now / 1000, dt);
          inst.render(r, this.cam, out, c.width, c.height);
        } catch (e) {
          logLine(`cube: ${e instanceof Error ? `${e.message} ${e.stack ?? ""}` : String(e)}`);
        }
      }
    }
    this.raf = this.items.size ? requestAnimationFrame(this.tick) : 0;
  };
}

export const engine = new Engine();
