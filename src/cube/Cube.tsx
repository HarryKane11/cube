import { useEffect, useMemo, useRef, useState } from "react";
import { knowIcon, type KnowIcon } from "./icons";
import { AGENTS, type Status } from "../agents/types";
import { useCube } from "../state/store";

/** The face colors picked for the role this cube stands for, as one string that changes when they do. */
function useSkin(color: string): string {
  return useCube((s) => {
    const agent = AGENTS.find((a) => a.color.toLowerCase() === color.toLowerCase());
    return agent ? (s.palettes[agent.id]?.join() ?? "") : "";
  });
}
import { engine, type CubeInst } from "./engine";

interface CubeProps {
  color: string;
  status: Status;
  size: number;
}

/** A live 3D cube. Its layers twist while it works and its face follows its status. */
export function Cube({ color, status, size }: CubeProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const inst = useRef<CubeInst | null>(null);
  const [flat, setFlat] = useState(false);
  const skin = useSkin(color);

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

  if (flat) return <FlatCube color={color} size={size} />;
  return <canvas ref={ref} className="cube" style={{ width: size, height: size }} aria-hidden="true" />;
}

/** A still picture of a resting cube, for avatars in the thread history. */
export function CubeStill({ color, size }: { color: string; size: number }) {
  const skin = useSkin(color);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const url = useMemo(() => engine.still(color), [color, skin]);
  if (!url) return <FlatCube color={color} size={size} />;
  return <img className="cube" src={url} width={size} height={size} alt="" />;
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
