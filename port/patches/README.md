# ET: Legacy WebAssembly port — split patch set

The port is shipped as a patch against **ET: Legacy `v2.84.0`** (git commit
**`764ffc00a953e59aaf435272d004c49a89710309`**, the tagged release — live servers
run this, so building against the exact tag avoids client/server version-mismatch
connection issues).

The port is these **eleven patches, split by concern** so each piece is small and
reviewable. Apply all eleven in numeric order. (There is intentionally no single
combined patch — maintain the split files only.)

## Apply

```bash
git clone https://github.com/etlegacy/etlegacy.git
cd etlegacy
git checkout v2.84.0                       # == 764ffc0
git submodule update --init --recursive    # needs libs/ (minizip, cjson, sqlite3, ...)

for p in ../port/patches/[0-9]*.patch; do git apply "$p"; done
```

All patches apply with plain `git apply` (no fuzz, no `--3way` needed) on a clean
`v2.84.0` checkout. On Linux, `../build-wasm.sh configure && ../build-wasm.sh` (repo
root) drives the whole build via emsdk + ninja.

## Also required: the emsdk patch (`../emsdk-patches/`)

These patch the etlegacy tree. One more patch fixes **Emscripten itself** and lives
in `port/emsdk-patches/` because it can't apply to the engine tree:

- `libglemu-addfunction-sig.patch` — without it a `MAIN_MODULE` build **aborts at
  boot** with *"Missing signature argument to addFunction"* (the GL-emulation
  wrappers reassigned in `GLImmediate.setupHooks()` lose their `.sig`, which
  `reportUndefinedSymbols → addFunction` needs under ASSERTIONS when a SIDE_MODULE
  imports them).

`build-wasm.sh configure` applies it automatically (idempotently); or run
`../build-wasm.sh patch-emsdk` directly. **Re-run after any `emsdk install`/update**,
which resets the SDK's source files.

## The eleven pieces

| # | File | Touches | What it does |
|---|------|---------|--------------|
| 01 | `01-build-system.patch` | `CMakeLists.txt`, `cmake/ETL*.cmake`, `emscripten_*.ps1` | Emscripten build: back the `bundled_*` targets with Emscripten ports (SDL2/zlib/jpeg) + vendored minizip/cJSON/sqlite3, MAIN_MODULE engine + SIDE_MODULE mods, link flags, `.ps1` helpers. |
| 02 | `02-platform-defines.patch` | `q_platform.h`, `q_shared.h` | `__EMSCRIPTEN__` platform block: `ARCH_STRING "wasm32"`, `DLL_EXT ".wasm"`, endianness, CPUSTRING. |
| 03 | `03-networking.patch` | `net_ip.c`, **`net_emscripten.c`** (new) | WebSocket↔UDP transport: numeric-IP parse, known-host table (master/motd), `NET_GetPacket`/`Sys_SendPacket`/`NET_Init`/`NET_Sleep` hooks, the WS ring-buffer transport. |
| 04 | `04-vm-and-mod-entry.patch` | `vm.c`, `cg_main.c`, `ui_main.c`, `g_main.c` | 17-parameter `vmMain` (`command` + `arg0..arg15`) for the SIDE_MODULE mods; `VM_CallFunc` NULL-vm no-op so the engine survives without ui/cgame. |
| 05 | `05-client-console-ui.patch` | `cl_main.c`, `cl_parse.c`, `cl_scrn.c`, `cl_ui.c`, `client.h` | Run without a UI VM (draw engine console), `vid_restart` no-op, download re-ack over the lossy WS hop, pure-checksum debug prints. |
| 06 | `06-collision-workaround.patch` | `cm_load.c`, `cm_local.h`, `cm_test.c`, `cm_trace.c` | Back up **all** trace-critical collision arrays (planes/brushsides/brushes/nodes/leafs/leafbrushes/leafsurfaces) after load and restore any a checksum shows corrupt, at the top of each trace + bounds guards. Fixes fall-through-the-world (the stray write corrupts `cm.planes`, not just `cm.leafs`). |
| 07 | `07-filesystem-pure.patch` | `files.c` | `FS_EMS_MarkModRef` — flag the real mod pak as the cgame/ui reference so a pure server accepts our loose-wasm-module client. |
| 08 | `08-common-exec-hook.patch` | `common.c` | `ETL_ExecCommand` — JS→engine console-command entry point (`Module.ccall`). Also moves `q_unicode.h` include out of the `FEATURE_DBMS` guard. |
| 09 | `09-renderer-gles.patch` | `tr_init.c`, `tr_image.c`, **`emscripten_gl_shim.c`** (new) | Request an ES2/WebGL context for the GLES1 renderer (served by `LEGACY_GL_EMULATION`); `glClipPlanef` no-op shim; **build mip chains with `glGenerateMipmap()`** since WebGL has no `GL_GENERATE_MIPMAP` (without it world textures are incomplete → black). |
| 10 | `10-sys-console-mainloop.patch` | `sys_main.c`, `sys_unix.c`, `con_tty.c` | `emscripten_set_main_loop(Com_Frame, ...)` so the browser owns the loop; drop `execinfo`/backtrace; disable the tty stdin console (browser `read(stdin)` becomes a blocking `window.prompt()` that freezes the loop). |
| 11 | `11-download-proxy.patch` | `download.c`, **`dl_emscripten.c`** (new) | HTTP pak downloads (pure servers) proxied through the bridge's `/dl` endpoint (server-side fetch + per-origin cache; no libcurl/CORS). Falls back to UDP-over-bridge if the server's www mirror can't serve a pak; skips per-server pak containerization so downloaded paks reload cleanly and persist in IDBFS. Selected via the `EMSCRIPTEN` branch in patch 01's `cmake/ETLSetupFeatures.cmake`. |

## Regenerating

From an applied tree (with the fork's `.git` present), regenerate a single group,
e.g. networking:

```bash
git diff -- src/qcommon/net_ip.c src/sys/net_emscripten.c > ../port/patches/03-networking.patch
```

The helper `../port/regen-patches.sh` regenerates all ten from an applied
`etlegacy/` checkout.
