import { useEffect, useMemo } from "react";
import { useLottie } from "lottie-react";
import { useCube } from "../state/store";
import { BOX, hasBehind, toLottie, toSvg, type Layer } from "./props/build";
import { propById } from "./props/catalog";

/** The animations and pictures are made once each and kept: a list of twenty messages shows the same few. */
const animations = new Map<string, object>();
const pictures = new Map<string, string>();

function animationOf(id: string, layer: Layer): object | undefined {
  const entry = propById(id);
  // Few props have anything behind the cube: for the rest that layer is not made at all.
  if (!entry || (layer === "behind" && !hasBehind(entry.def))) return undefined;
  const key = `${id}:${layer}`;
  if (!animations.has(key)) animations.set(key, toLottie(entry.def, entry.id, layer));
  return animations.get(key);
}

function pictureOf(id: string, layer: Layer): string | undefined {
  const entry = propById(id);
  if (!entry || (layer === "behind" && !hasBehind(entry.def))) return undefined;
  const key = `${id}:${layer}`;
  if (!pictures.has(key)) pictures.set(key, toSvg(entry.def, layer));
  return pictures.get(key);
}

/** Over the cube's own square and a little beyond it on every side, so a hat can sit above and a tool reach out. */
const frame: React.CSSProperties = { position: "absolute", inset: "-10%", width: "120%", height: "120%", pointerEvents: "none", overflow: "visible" };
/** The same square under the cube, for what is on the cube's far side. The cube's holder keeps it from going under anything else. */
const frameBehind: React.CSSProperties = { ...frame, zIndex: -1 };
const frameOf = (layer: Layer) => (layer === "behind" ? frameBehind : frame);

/** What the cube holds, at rest. For the many small cubes beside past messages, where nothing should move. */
export function PropStill({ id, layer = "front" }: { id: string; layer?: Layer }) {
  const picture = pictureOf(id, layer);
  if (!picture) return null;
  return <svg viewBox={`0 0 ${BOX} ${BOX}`} style={frameOf(layer)} aria-hidden="true" dangerouslySetInnerHTML={{ __html: picture }} />;
}

/**
 * What the cube holds, in use while `busy`: writing, looking closer, striking. At rest it is
 * still, in the pose the motion starts from. People who asked for less motion get the still one.
 */
export function PropLive({ id, busy, layer = "front" }: { id: string; busy: boolean; layer?: Layer }) {
  const calm = useCube((s) => s.settings.calm);
  const still = useMemo(() => calm || (typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches), [calm]);
  const animation = animationOf(id, layer);
  if (!animation || still) return <PropStill id={id} layer={layer} />;
  return <Moving animation={animation} busy={busy} layer={layer} />;
}

function Moving({ animation, busy, layer }: { animation: object; busy: boolean; layer: Layer }) {
  // A cube that is already at work when it comes on screen starts by itself: asking it to play
  // before the animation has loaded would be lost.
  const lottie = useLottie({ src: animation, autoplay: busy, loop: true });
  useEffect(() => {
    if (busy) lottie.play();
    else lottie.stop();
    // The instance is stable; only whether the cube is at work matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy]);
  return <div ref={lottie.setDisplayRef} style={frameOf(layer)} aria-hidden="true" />;
}
