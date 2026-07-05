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
  a WebSocket to `bridge/etl-ws-bridge.js`, which relays it as real UDP. The
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
- `bridge/` — the Node WebSocket↔UDP bridge (`etl-ws-bridge.js`).
- `web/shell.html` — the Emscripten HTML shell (canvas + loader + args).
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

## Run

```powershell
# serve the build directory over HTTP (wasm needs http, not file://)
python -m http.server 8080 --directory etlegacy/build-wasm
# open http://localhost:8080/etl.html
```

## Connect to live servers

Start the bridge, then load the client (its `net_wsbridge` cvar defaults to
`ws://localhost:9000/`):

```powershell
cd bridge
npm install ws        # once
node etl-ws-bridge.js --port 9000
```

Get a live server address from
`https://www.etlegacy.com/servers` and, from the in-game console (or via a
`+serverstatus <ip:port>` startup arg in `web/shell.html`), query it — e.g.
`serverstatus 37.187.251.48:27960`. The bridge logs the UDP relay and the
server's reply appears in the browser console.

The server browser works: the master server is reached (its hostname resolves
via a small known-host table in `net_ip.c`, plus numeric IPs in `web/shell.html`),
so `globalservers 0 84 empty full` populates the list and you can `connect` to any
of them. Arbitrary hostnames still need a numeric `ip:port`.
