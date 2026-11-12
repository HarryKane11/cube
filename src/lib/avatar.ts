/** A profile picture as it is kept and sent to the team: a small square JPEG, as a `data:` address. */

/** The longest address the team's relay takes for a picture. */
export const MAX_AVATAR = 24_000;

/** True for a picture that may be shown: a small bitmap given as a `data:` address. Never SVG, which can carry script. */
export function validAvatar(text: unknown): text is string {
  return typeof text === "string" && text.length <= MAX_AVATAR && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(text);
}

/**
 * Makes the picture from an image the person picked: the middle square, scaled down, saved as
 * JPEG, made smaller until it fits what the relay takes.
 */
export async function toAvatar(file: Blob): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  for (const [px, quality] of [[128, 0.85], [128, 0.7], [96, 0.7], [72, 0.65]] as const) {
    const canvas = document.createElement("canvas");
    canvas.width = px;
    canvas.height = px;
    const g = canvas.getContext("2d");
    if (!g) break;
    g.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, px, px);
    const url = canvas.toDataURL("image/jpeg", quality);
    if (validAvatar(url)) return url;
  }
  throw new Error("That picture could not be used. Try another one.");
}
