import { describe, expect, it } from "vitest";
import { scrambled, turned } from "./CubeMark";

// Faces in order: top, right, left. Nine tiles each, row by row.
const TOP = 0, RIGHT = 9, LEFT = 18;
const numbered = () => Array.from({ length: 27 }, (_, i) => i);

describe("the mark being solved", () => {
  it("starts with every tile in one of the three shades", () => {
    const tiles = scrambled();
    expect(tiles).toHaveLength(27);
    expect(tiles.every((t) => t >= 0 && t <= 2)).toBe(true);
  });

  it("turns a flat layer to the right: the left face's row goes onto the right face, and new tiles come into view", () => {
    const after = turned(numbered(), 1, [100, 101, 102]);
    expect(after.slice(RIGHT + 3, RIGHT + 6)).toEqual([LEFT + 3, LEFT + 4, LEFT + 5]);
    expect(after.slice(LEFT + 3, LEFT + 6)).toEqual([100, 101, 102]);
    // The other layers stay where they were.
    expect(after.slice(TOP, TOP + 9)).toEqual(numbered().slice(TOP, TOP + 9));
    expect(after.slice(LEFT, LEFT + 3)).toEqual([LEFT, LEFT + 1, LEFT + 2]);
  });

  it("brings a row of the top down the left face, and a column of it down the right", () => {
    const left = turned(numbered(), 3, [100, 101, 102]);
    // The tile of the top that touched the left face ends up at the bottom of it.
    expect([left[LEFT], left[LEFT + 3], left[LEFT + 6]]).toEqual([TOP + 2, TOP + 1, TOP]);
    const right = turned(numbered(), 8, [100, 101, 102]);
    expect([right[RIGHT + 2], right[RIGHT + 5], right[RIGHT + 8]]).toEqual([TOP + 2, TOP + 5, TOP + 8]);
    expect([right[TOP + 2], right[TOP + 5], right[TOP + 8]]).toEqual([100, 101, 102]);
  });

  it("keeps all 27 tiles through any turn", () => {
    let tiles = scrambled();
    for (let layer = 0; layer < 9; layer++) tiles = turned(tiles, layer);
    expect(tiles).toHaveLength(27);
    expect(tiles.every((t) => t >= 0 && t <= 2)).toBe(true);
  });
});
