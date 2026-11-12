import type { Lang } from "../i18n";

/** A typeface the person can pick. `family` is what goes into the font list; empty means the system's own. */
export interface Typeface {
  id: string;
  name: string;
  family: string;
}

/** Typefaces for Latin text. The system one is San Francisco on a Mac. */
export const FONTS_EN: Typeface[] = [
  { id: "system", name: "System", family: "" },
  { id: "inter", name: "Inter", family: '"Inter Variable"' },
  { id: "geist", name: "Geist", family: '"Geist Variable"' },
  { id: "roboto", name: "Roboto", family: '"Roboto Variable"' },
  { id: "plex", name: "IBM Plex Sans", family: '"IBM Plex Sans"' },
  { id: "helvetica", name: "Helvetica Neue", family: '"Helvetica Neue"' },
  { id: "georgia", name: "Georgia", family: "Georgia" },
];

/** Typefaces for Hangul. The system one is Apple SD Gothic Neo on a Mac. */
export const FONTS_KO: Typeface[] = [
  { id: "system", name: "System", family: "" },
  { id: "pretendard", name: "Pretendard", family: '"Cube KR Pretendard"' },
  { id: "noto", name: "Noto Sans KR", family: '"Cube KR Noto Sans"' },
  { id: "nanum", name: "Nanum Gothic", family: '"Cube KR Nanum Gothic"' },
  { id: "plex", name: "IBM Plex Sans KR", family: '"Cube KR Plex"' },
  { id: "gowun", name: "Gowun Dodum", family: '"Cube KR Gowun Dodum"' },
  { id: "myeongjo", name: "Nanum Myeongjo", family: '"Cube KR Nanum Myeongjo"' },
];

/** Korean names of the Korean typefaces, for the Korean screen. */
export const FONT_NAMES_KO: Record<string, string> = { system: "시스템 기본", nanum: "나눔고딕", myeongjo: "나눔명조", gowun: "고운돋움" };

export const fontName = (f: Typeface, lang: Lang) => (lang === "ko" ? (FONT_NAMES_KO[f.id] ?? f.name) : f.name);

/**
 * The font list for the app: the Korean face first (it only covers Hangul), then the Latin one,
 * then the system's. Unknown ids count as the system typeface.
 */
export function fontStack(en: string, ko: string): string {
  const pick = (list: Typeface[], id: string) => list.find((f) => f.id === id)?.family ?? "";
  return [pick(FONTS_KO, ko), pick(FONTS_EN, en), "-apple-system", "BlinkMacSystemFont", '"Helvetica Neue"', "Arial", "sans-serif"].filter(Boolean).join(", ");
}

/** Puts the chosen typefaces to work across the app. */
export function applyFonts(en: string, ko: string): void {
  document.documentElement.style.setProperty("--app-font", fontStack(en, ko));
}
