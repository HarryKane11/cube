# Cube

A desktop workspace where people and AI agents work together. Agents are 3D cube characters; what they make shows up on a shared Stage.

## Run

```bash
pnpm install
pnpm tauri dev
```

Needs Node, pnpm and Rust. The team is five role cubes (Researcher, Writer, Builder, Designer, Reviewer). Each role runs on one of the agent CLIs already installed on this machine: `claude`, `codex`, `hermes`. Each CLI must be signed in on its own; which one powers which role is set in the welcome flow and in Settings.

`pnpm dev` alone opens the screens in a browser at http://localhost:1420 with scripted stand-in agents, which is handy for working on the UI.

### Building the app on a Mac

```bash
pnpm app
```

This builds `src-tauri/target/debug/bundle/macos/Cube.app` and signs it.

macOS ties permissions (Screen Recording, Keychain access) to how an app is signed. An unsigned local build looks like a new app after every rebuild, and macOS would ask for the permission again each time. So the first `pnpm app` on a computer makes a local signing identity and installs the signing tool (`cargo install apple-codesign`, a few minutes, once), and every build after that is signed with it. You allow Screen Recording once and are not asked again.

The identity is a self-signed certificate and key in `~/.cube-signing`, outside the repository. No keychain and no system setting is touched. `CUBE_NO_SIGN=1 pnpm app` leaves a build unsigned.

If macOS keeps asking although Cube is switched on under Privacy & Security > Screen & System Audio Recording, the entry there belongs to an earlier, differently signed build. Remove Cube from that list (select it, press `−`), open Cube, and allow it once more. In a terminal: `tccutil reset ScreenCapture app.cube.desktop`.

### Handing Cube to teammates

```bash
pnpm dmg
```

This builds Cube for Apple silicon and Intel, signs it with the same local identity, and writes `src-tauri/target/universal-apple-darwin/release/bundle/dmg/Cube_<version>_universal.dmg`.

- Make every disk image on the computer that holds `~/.cube-signing` (or a copy of it). Images signed with the same identity are the same app to macOS, so a teammate allows Screen Recording once and keeps it across updates. An image signed with another identity is a new app, and they are asked again.
- The certificate is self-signed, so the first time a teammate opens the app macOS says it cannot verify it. They confirm once under System Settings > Privacy & Security > Open Anyway. Only a paid Apple Developer ID removes that step.
- A teammate should use either the disk image or their own build from source, not both: the two are signed differently and macOS keeps one permission entry per app name.

## How it works

- `src-tauri/src/lib.rs`: starts agent CLIs as child processes, streams their output to the window, lists and reads files under `~/CubeSpaces`.
- `src/agents/adapters.ts`: turns each CLI's output into the same small set of events.
- `src/agents/types.ts`: the roles, their keywords, and `route()`, which picks a role for a message that names nobody.
- `src/agents/orchestrator.ts`: the thread. Who gets a message, `@Name` handoffs between agents, stepping in.
- `src/cube/`: the cube character. One shared WebGL renderer draws every cube; `faces.ts` holds the expression sheet.
- `src/components/`: sidebar, thread, Stage.

Each space is a folder at `~/CubeSpaces/<space>`. Agents run with that folder as their working directory, and any file they write there appears on the Stage.
