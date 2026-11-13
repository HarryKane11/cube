/**
 * What sets Cube's own cube apart from its teammates'. Cube can be drawn as the app's flat mark
 * or as a cube that turns like the others; either way the person may give it colors of its own
 * and a figure, on every tile or once across its front. This file says, for the cube that turns,
 * what the person chose: the engine (engine.ts) asks it when it builds that cube.
 */
import { AGENTS, ROUTER } from "../agents/types";
import { useCube } from "../state/store";
import { CUSTOM_FILL, FILLS, SYMBOLS, type CubeLook } from "./CubeMark";

export interface Decor {
  /** The cube's colors: front, top, side. Unset: the role's own. */
  colors?: [string, string, string];
  /** A figure on the stickers, as a path drawn in a square of 1 by 1. */
  symbol?: string;
  /** On every sticker of the cube, or once, large, across the nine of its front. */
  spread: "tiles" | "face";
}

const routerColor = (): string | undefined => AGENTS.find((a) => a.id === ROUTER)?.color.toLowerCase();

/** True for the color that stands for Cube itself. */
export const isCubeItself = (color: string): boolean => routerColor() === color.toLowerCase();

/** The look the person gave Cube, as it is stored. */
export const cubeLook = (): CubeLook => useCube.getState().settings.cubeLook ?? {};

/** What the turning cube of this color is dressed in, or undefined for a cube that is only its role's colors. */
export function decorOf(color: string): Decor | undefined {
  if (!isCubeItself(color)) return undefined;
  const look = cubeLook();
  const stops = FILLS.find((f) => f.id === look.fill)?.stops;
  const symbol = SYMBOLS.find((s) => s.id === look.symbol)?.d;
  // The person's own colors are already front, top, side.
  const picked = look.fill === CUSTOM_FILL ? look.colors : undefined;
  if (!stops && !symbol && !picked) return undefined;
  // The gradient runs from the top of the cube down: its first color is the top's, its last the side's.
  return { colors: picked ?? (stops ? [stops[1], stops[0], stops[2]] : undefined), symbol, spread: look.spread === "tiles" ? "tiles" : "face" };
}

/** A word that changes whenever the dress of this color's cube does, for whatever keeps a picture of it. */
export const decorKey = (color: string): string => (isCubeItself(color) ? JSON.stringify(cubeLook()) : "");
