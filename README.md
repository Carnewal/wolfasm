# ET: Legacy — WebAssembly (browser) build

A WebAssembly port of [ET: Legacy](https://github.com/etlegacy/etlegacy) (the
open-source Wolfenstein: Enemy Territory engine) that runs in the browser, plus
a WebSocket↔UDP bridge so the browser client can talk to real live ET servers.

## What works

- **Engine runs & renders in the browser** — the ET: Legacy engine compiled to
  wasm boots, mounts the real game `pk3` assets, initialises SDL2 + a WebGL
  renderer, sound, and input, and runs its main loop.
- **Full menu & UI** — `cgame`, `ui`, and `qagame` are built as Emscripten
  **SIDE_MODULE** `.wasm` and `dlopen`'d by the `MAIN_MODULE` engine, so the real
  ET: Legacy menu system works (create profile, options, server browser).
- **In-game with 3D graphics** — a local match (`map oasis`) loads the BSP + all
  mods + HUD + weapons and renders the in-game command map / player-setup screen;
  the full cgame render path runs in the browser.
- **Connects to live servers** — the wasm client tunnels the ET UDP netchan over
  a WebSocket to the Go server (`bridge/main.go`, `/ws`), which relays it as real UDP. The
  server browser populates from the real master server, and a direct `connect`
  completes the full protocol handshake (challenge → connect → gamestate) with
  live snapshots flowing from real servers.

- **Pure servers & downloads**: joining a pure server that requires a pk3 the
  client lacks now works — the UDP "windowed" download flows over the WebSocket
  relay (verified pulling a 94 MB pak from a live ETJump server). The stall was
  the bridge doing a synchronous `console.log` per packet, which starved Node's
  event loop and made the server's download window time out; the bridge now
  rate-limits logging (`--verbose` for the old per-packet output), and the client
  re-acks blocks the server re-sends after an ack is lost on the UDP hop.

### Known limitations

- **Collision (local listen-server only)**: a stray write during client init on
  a *local* `devmap` corrupts the collision `cm.leafs[].area` array (PVS/area
  data — physical collision via `leafbrushes` is unaffected). It previously
  crashed the server (`CM_AreasConnected: area >= cm.numAreas`), which wiped the
  whole collision model; the area functions are now non-fatal under
  `__EMSCRIPTEN__` so the server survives and play continues. On live servers the
  remote server does PVS, so this does not affect online play. The stray write
  itself is not yet pinned (needs a wasm memory watchpoint).

## Driving it from the URL (no rebuild)

`web/shell.html` reads URL parameters so you can drive the client without
relinking:

- `etl.html?connect=1.2.3.4:27960` — auto-connect to a server
- `etl.html?exec=map%20oasis` — run console commands (`;`-separated)

## Layout

- `etlegacy/` — the engine source with the Emscripten port changes (all guarded
  by `__EMSCRIPTEN__` / `EMSCRIPTEN`). Key additions:
  - `cmake/ETLEmscripten.cmake` — backs the bundled-lib targets with Emscripten
    ports (SDL2, zlib, libjpeg) + vendored minizip/cJSON, sets link flags.
  - `src/sys/emscripten_gl_shim.c` — a couple of fixed-function GL entry points
    missing from Emscripten's `LEGACY_GL_EMULATION`.
  - `src/sys/net_emscripten.c` — WebSocket transport for networking.
  - `emscripten_configure.ps1`, `emscripten_build.ps1` — build helpers.
- `bridge/` — the unified Go server (`main.go`): serves the shell + WebSocket↔UDP
  relay (`/ws`) + pk3 download proxy (`/dl`) on one port.
- `web/shell.html` — the Emscripten HTML shell (markup); `web/shell.js` — the
  browser-side logic (Module setup, IDBFS persistence, faker name, download proxy,
  URL-driven connect/devmap). `shell.html` is baked into `etl.html` at link time;
  `shell.js` is served alongside it.
- `Dockerfile` — whole end-to-end build → self-contained serving image.
- `assets/etmain/` — the retail ET `pk3` files (downloaded separately).
- `emsdk/` — the Emscripten SDK.

## Build

Prerequisites: the toolchain in `emsdk/` (Emscripten 6.x), CMake, Ninja, Python.

```powershell
# from etlegacy/
./emscripten_configure.ps1     # emcmake cmake -> build-wasm  (minimal client)
./emscripten_build.ps1         # ninja -> build-wasm/etl.{html,js,wasm}
```

Notable configure options (a minimal browser client): `BUILD_SERVER=OFF`,
`BUILD_MOD=OFF`, `RENDERER_DYNAMIC=OFF`, `FEATURE_RENDERER_GLES=ON`, most
optional features off. See `emscripten_configure.ps1`.

### Assets

Game data is packaged separately from the wasm so rebuilds are fast:

```powershell
# etmain/*.pk3 come from https://mirror.etlegacy.com/etmain/
python emsdk/upstream/emscripten/tools/file_packager.py `
  build-wasm/etl.data --preload assets@/etl --js-output=build-wasm/etl_data.js
```

`web/shell.html` loads `etl_data.js` (which populates the virtual FS at `/etl`)
before the module, and passes `+set fs_basepath /etl`.

> Note: editing `web/shell.html` does **not** re-trigger a link (Ninja does not
> track `--shell-file`). Delete `build-wasm/etl.html` before rebuilding.

## Run with Docker (whole thing, one command)

The `Dockerfile` does the entire end-to-end build — clone ET:Legacy v2.84.0, apply
the port patches, build the wasm client, download the game data + package it, build
the Go server — and produces a self-contained image that serves the game:

```bash
docker build -t wolfasm .
docker run -p 8080:8080 wolfasm        # open http://localhost:8080/
```

`/` lands straight in the game. For a deployment (e.g. `play.wolfasm.com`) put it
behind a TLS-terminating proxy; the client auto-uses `wss://` over HTTPS.

## Run without Docker (unified Go server)

`bridge/` is a single Go binary that serves the shell **and** the WebSocket↔UDP
relay **and** the pk3 download proxy on **one port**, so the client talks to one
origin (and reaches live servers out of the box). See `bridge/README.md`.

```bash
cd bridge
go build -o wolfasm-server .      # Go 1.23+
WOLFASM_WEBROOT=../etlegacy/build-wasm ./wolfasm-server
# open http://localhost:8080/
```

The client derives `ws(s)://<host>/ws` and `<origin>/dl` from the page URL, so the
same build works on `localhost` and on a deployed host (e.g. `play.wolfasm.com`)
unchanged. Configure per deployment via `.env` (`WOLFASM_ADDR`, `WOLFASM_TLS_*`,
`WOLFASM_PUBLIC_HOST`, …) — see `bridge/.env.example`. The page is auto-assigned a
random player name (faker) on first load, stored in `localStorage` + the profile.

From the in-game console (or a `+serverstatus <ip:port>` startup arg), query a
live server, e.g. `serverstatus 78.46.121.107:27961`; joining a pure server
auto-downloads its paks through the proxy (cached per origin).


The server browser works: the master server is reached (its hostname resolves
via a small known-host table in `net_ip.c`, plus numeric IPs in `web/shell.html`),
so `globalservers 0 84 empty full` populates the list and you can `connect` to any
of them. Arbitrary hostnames still need a numeric `ip:port`.
