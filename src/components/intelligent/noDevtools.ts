/**
 * The renderer mounts an inspecting panel of its own when the app runs in development. Cube
 * shows nothing it did not put on screen itself: this says the panel is already mounted. It has
 * to run before the renderer is read, so it is a module of its own, imported first.
 */
(globalThis as Record<symbol, unknown>)[Symbol.for("openui.devtools.autoMount")] = true;

export {};
