import { useEffect, useMemo, useRef, useState } from "react";
import { knowIcon, type KnowIcon } from "./icons";
import { AGENTS, ROUTER, propOf, type Status } from "../agents/types";
import { CubeMark, SolvingMark } from "./CubeMark";
import { isCubeItself } from "./decor";
import { PropLive, PropStill } from "./Prop";
import { useCube } from "../state/store";

/** The face colors picked for the role this cube stands for, as one string that changes when they do. */
function useSkin(color: string): string {
  return useCube((s) => {
    const agent = AGENTS.find((a) => a.color.toLowerCase() === color.toLowerCase());
    // Cube's own cube also changes with the look the person gave it.
    return agent ? `${s.palettes[agent.id]?.join() ?? ""}${agent.id === ROUTER ? JSON.stringify(s.settings.cubeLook ?? {}) : ""}` : "";
  });
}

/**
 * Cube itself is drawn as the app's flat mark, unless the person chose to have it as a cube
 * that turns like its teammates'. True when this color is Cube's and the mark is what to draw.
 */
function useFlatMark(color: string): boolean {
  return useCube((s) => isCubeItself(color) && s.settings.cubeLook?.shape !== "cube");
}
import { engine, type CubeInst } from "./engine";

/** What the cube of this color holds: the role's own, unless the caller says otherwise (`null` for nothing). */
function useProp(color: string, given?: string | null): string | undefined {
  const own = useCube((s) => {
    const agent = AGENTS.find((a) => a.color.toLowerCase() === color.toLowerCase());
    return agent ? propOf(agent, s.outfits) : undefined;
  });
  return given === undefined ? own : (given ?? undefined);
}

interface CubeProps {
  color: string;
  status: Status;
  size: number;
  /** Shows this prop in place of the role's own, or none when `null`. For trying one on. */
  prop?: string | null;
  /** Keeps the prop moving whatever the status is. For showing what it does. */
  lively?: boolean;
}

/** The cube's square, with room made around it for what the cube holds. */
const holder = (size: number): React.CSSProperties => ({ position: "relative", width: size, height: size, isolation: "isolate" });

/** A live 3D cube. Its layers twist while it works and its face follows its status. */
export function Cube({ color, status, size, prop: given, lively }: CubeProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const inst = useRef<CubeInst | null>(null);
  const [flat, setFlat] = useState(false);
  const skin = useSkin(color);
  const prop = useProp(color, given);
  const busy = lively || status === "thinking" || status === "working";
  const calm = useCube((s) => s.settings.calm);
  const flatMark = useFlatMark(color);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = canvas.height = Math.round(size * dpr);
    const made = engine.add(canvas, color, status);
    inst.current = made;
    setFlat(!made);
    return () => {
      if (made) engine.remove(made);
      inst.current = null;
    };
    // The status is pushed in below; it must not rebuild the cube.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [color, size, skin]);

  useEffect(() => {
    if (inst.current) inst.current.want = status;
  }, [status]);

  if (flatMark) {
    return (
      <span className="cube flex items-center justify-center" style={holder(size)}>
        {busy && !calm ? <SolvingMark size={size} /> : <CubeMark size={size} />}
      </span>
    );
  }
  if (flat && !prop) return <FlatCube color={color} size={size} />;
  return (
    <span className="cube" style={holder(size)}>
      {flat ? <FlatCube color={color} size={size} /> : <canvas ref={ref} className="cube" style={{ width: size, height: size }} aria-hidden="true" />}
      {prop && <PropLive id={prop} busy={busy} layer="behind" />}
      {prop && <PropLive id={prop} busy={busy} />}
    </span>
  );
}

/** A still picture of a resting cube, for avatars in the thread history. */
export function CubeStill({ color, size, prop: given }: { color: string; size: number; prop?: string | null }) {
  const skin = useSkin(color);
  const prop = useProp(color, given);
  const flatMark = useFlatMark(color);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const url = useMemo(() => (flatMark ? null : engine.still(color)), [color, skin, flatMark]);
  if (flatMark) return <span className="cube flex items-center justify-center" style={holder(size)}><CubeMark size={size} /></span>;
  const cube = url ? <img className="cube" src={url} width={size} height={size} alt="" /> : <FlatCube color={color} size={size} />;
  if (!prop) return cube;
  return <span className="cube" style={holder(size)}><PropStill id={prop} layer="behind" />{cube}<PropStill id={prop} /></span>;
}

/**
 * One of Cube's own pictures for what a team knows and can do (a piece for memory, the core for
 * skills, an outside piece for MCP servers…), drawn like the cubes. Where WebGL is unavailable
 * the `fallback` icon is shown.
 */
export function KnowMark({ kind, size, fallback }: { kind: KnowIcon; size: number; fallback?: React.ReactNode }) {
  const url = useMemo(() => knowIcon(kind), [kind]);
  if (!url) return <>{fallback ?? null}</>;
  return <img src={url} width={size} height={size} alt="" draggable={false} className="flex-none" style={{ transform: "scale(1.3)" }} />;
}

function FlatCube({ color, size }: { color: string; size: number }) {
  return (
    <span className="cube-flat" style={{ width: size * 0.74, height: size * 0.74, margin: size * 0.13, background: color }} aria-hidden="true">
      <i /><i />
    </span>
  );
}
