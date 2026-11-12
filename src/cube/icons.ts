import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { engine } from "./engine";

/**
 * Cube's own pictures for what a team knows and can do. Each kind has an object of its own, so
 * they can be told apart at a glance even when small, drawn by the cubes' renderer and lit the
 * same way so they sit beside the cubes as one family:
 * - memory: a cut gem. Something kept because it is worth keeping.
 * - wiki: an open book. Memory arranged for reading.
 * - skill: a lightning bolt. The ability to get something done.
 * - mcp: a plug. A connection to a tool outside the team.
 * - plugin: a puzzle piece. A part that is added on.
 */
export type KnowIcon = "memory" | "wiki" | "skill" | "mcp" | "plugin";

function lights(scene: THREE.Scene): void {
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a93a8, 2.4));
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(3, 5, 6);
  const fill = new THREE.DirectionalLight(0xffffff, 0.8);
  fill.position.set(-5, 1, 3);
  scene.add(key, fill);
}

function build(kind: KnowIcon, scene: THREE.Scene): () => void {
  const made: { dispose(): void }[] = [];
  const keep = <T extends { dispose(): void }>(x: T): T => {
    made.push(x);
    return x;
  };
  const mat = (color: string, o: { roughness?: number; metalness?: number; flat?: boolean } = {}) =>
    keep(new THREE.MeshStandardMaterial({ color, roughness: o.roughness ?? 0.42, metalness: o.metalness ?? 0, flatShading: o.flat ?? false }));
  /** A flat outline given thickness and a soft edge, centered on the origin. */
  const slab = (shape: THREE.Shape, depth: number) => {
    const g = keep(new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelThickness: 0.09, bevelSize: 0.09, bevelSegments: 3, curveSegments: 20 }));
    g.center();
    return g;
  };
  lights(scene);
  const root = new THREE.Group();
  scene.add(root);

  if (kind === "memory") {
    // A gem: a low crown over a deep point, with flat facets that catch the light.
    const violet = mat("#7A4DF0", { roughness: 0.18, metalness: 0.1, flat: true });
    const crown = new THREE.Mesh(keep(new THREE.CylinderGeometry(1.0, 1.75, 0.75, 8)), mat("#9B7BFF", { roughness: 0.18, metalness: 0.1, flat: true }));
    crown.position.y = 0.95;
    const point = new THREE.Mesh(keep(new THREE.ConeGeometry(1.75, 2.2, 8)), violet);
    point.rotation.x = Math.PI;
    point.position.y = -0.52;
    root.add(crown, point);
    root.rotation.set(0.32, 0.4, 0);
    root.position.y = 0.05;
  } else if (kind === "wiki") {
    // An open book: two covers in a shallow V, a block of pages on each.
    const cover = mat("#2F7BFF");
    const paper = mat("#F6F2E9", { roughness: 0.8 });
    const board = keep(new RoundedBoxGeometry(1.75, 0.16, 2.5, 3, 0.07));
    const block = keep(new RoundedBoxGeometry(1.55, 0.34, 2.3, 3, 0.06));
    for (const side of [-1, 1]) {
      const half = new THREE.Group();
      const c = new THREE.Mesh(board, cover);
      const p = new THREE.Mesh(block, paper);
      p.position.y = 0.22;
      half.add(c, p);
      half.position.x = side * 0.86;
      half.rotation.z = side * 0.24;
      half.position.y = 0.2;
      root.add(half);
    }
    const spine = new THREE.Mesh(keep(new RoundedBoxGeometry(0.3, 0.2, 2.5, 3, 0.07)), cover);
    root.add(spine);
    root.rotation.set(0.95, -0.5, 0);
    root.scale.setScalar(0.98);
  } else if (kind === "skill") {
    // A lightning bolt.
    const s = new THREE.Shape();
    s.moveTo(0.45, 1.95);
    s.lineTo(-1.05, -0.25);
    s.lineTo(-0.1, -0.25);
    s.lineTo(-0.55, -1.95);
    s.lineTo(1.05, 0.45);
    s.lineTo(0.1, 0.45);
    s.lineTo(0.45, 1.95);
    root.add(new THREE.Mesh(slab(s, 0.6), mat("#FFC21A", { roughness: 0.3 })));
    root.rotation.set(0.12, -0.55, 0.05);
    root.scale.setScalar(0.92);
  } else if (kind === "mcp") {
    // A plug: a body, two prongs, and the start of its cable. Silver: it comes from outside the team.
    const shell = mat("#C9CFD8", { roughness: 0.28, metalness: 0.55 });
    const steel = mat("#8E97A4", { roughness: 0.25, metalness: 0.8 });
    const body = new THREE.Mesh(keep(new RoundedBoxGeometry(2.1, 1.6, 1.2, 5, 0.34)), shell);
    const prong = keep(new RoundedBoxGeometry(0.3, 1.0, 0.56, 3, 0.07));
    for (const x of [-0.5, 0.5]) {
      const p = new THREE.Mesh(prong, steel);
      p.position.set(x, 1.25, 0);
      root.add(p);
    }
    const neck = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.42, 0.6, 0.5, 20)), shell);
    neck.position.y = -1.0;
    const cable = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.2, 0.2, 0.75, 16)), mat("#3A3D45"));
    cable.position.y = -1.55;
    root.add(body, neck, cable);
    root.rotation.set(0.3, -0.6, -0.42);
    root.position.set(-0.1, 0.1, 0);
    root.scale.setScalar(0.94);
  } else {
    // A puzzle piece: a square with a knob on one side and a socket on another.
    const h = 1.2;
    const r = 0.44;
    const s = new THREE.Shape();
    s.moveTo(-h, -h);
    s.lineTo(-r, -h);
    s.absarc(0, -h, r, Math.PI, 0, true);
    s.lineTo(h, -h);
    s.lineTo(h, -r);
    s.absarc(h + 0.08, 0, r, -Math.PI / 2 - 0.2, Math.PI / 2 + 0.2, false);
    s.lineTo(h, h);
    s.lineTo(-h, h);
    s.lineTo(-h, -h);
    root.add(new THREE.Mesh(slab(s, 0.62), mat("#1FA864", { roughness: 0.34 })));
    root.rotation.set(0.42, -0.5, 0.08);
    root.position.x = -0.15;
    root.scale.setScalar(0.96);
  }
  return () => made.forEach((m) => m.dispose());
}

/** The picture for one kind of thing, as an image URL, or null where WebGL is unavailable. */
export function knowIcon(kind: KnowIcon): string | null {
  return engine.shot(`know:${kind}`, (scene) => build(kind, scene));
}
