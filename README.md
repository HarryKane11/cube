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

This builds `src-tauri/target/debug/bundle/macos/Cube.app` and signs it. macOS ties permissions (Screen Recording, Keychain access) to how an app is signed, and an unsigned local build looks like a new app after every rebuild, so the permission would have to be given again each time. To keep it, set up a local signing identity once:

```bash
cargo install apple-codesign --locked
bash scripts/setup-signing.sh
```

That makes a self-signed certificate and key in `~/.cube-signing`, outside the repository. It touches no keychain and no system setting. Without it `pnpm app` still builds; it just says the build was left unsigned.

## How it works

- `src-tauri/src/lib.rs`: starts agent CLIs as child processes, streams their output to the window, lists and reads files under `~/CubeSpaces`.
- `src/agents/adapters.ts`: turns each CLI's output into the same small set of events.
- `src/agents/types.ts`: the roles, their keywords, and `route()`, which picks a role for a message that names nobody.
- `src/agents/orchestrator.ts`: the thread. Who gets a message, `@Name` handoffs between agents, stepping in.
- `src/cube/`: the cube character. One shared WebGL renderer draws every cube; `faces.ts` holds the expression sheet.
- `src/components/`: sidebar, thread, Stage.

Each space is a folder at `~/CubeSpaces/<space>`. Agents run with that folder as their working directory, and any file they write there appears on the Stage.
