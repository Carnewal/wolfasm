# TODO / Handoff — ET: Legacy WebAssembly port

Status snapshot for the next agent. Read this top-to-bottom before touching code.

## What this project is

A WebAssembly (browser) port of **ET: Legacy** (open-source Wolfenstein: Enemy
Territory engine, https://github.com/etlegacy/etlegacy), plus a **WebSocket↔UDP
bridge** so the browser client can talk to real live ET servers (browsers have no
UDP). Goal: run the game in the browser and play on live servers.

Layout (repo root `wolfasm/`):
- `etlegacy/` — engine source with all the Emscripten port changes (guarded by
  `__EMSCRIPTEN__` / `EMSCRIPTEN`). This is the code you edit.
- `web/shell.html` — Emscripten HTML shell (canvas + loader + startup args), baked
  into `etl.html` at link time (`--shell-file`).
- `bridge/main.go` — unified Go server: serves the shell + `/ws` relay + `/dl`
  download proxy on one port. `/` → shell. Config via `.env` (see
  `bridge/.env.example`, `bridge/README.md`). This is the only server/bridge now.
- **Not in git** (you must supply locally): `emsdk/` (Emscripten SDK),
  `assets/` + `assets_mods/` (retail + mod pk3s — copyrighted, keep them out of
  git), `etlegacy/build-wasm/` (build output + `etl.data` asset bundle + any
  downloaded server paks). See "Environment setup" below.

## ✅ RESOLVED — black/untextured 3D world + fall-through-the-world collision

Both former blockers are **fixed and verified in-browser** (local `devmap oasis`,
headless Chrome via WSLg — see "Environment setup"). The world renders fully
textured with mipmaps, and the player stands/walks on the ground.

**Textures (was: black world; "tan/untextured" on some GL backends).** The GLES1
renderer set the OpenGL-ES-1.1 auto-mipmap parameter
`glTexParameteri(GL_TEXTURE_2D, GL_GENERATE_MIPMAP, TRUE)` — a **no-op in
WebGL/GLES2**, so mip levels were never built. Under the default
`GL_LINEAR_MIPMAP_NEAREST` min-filter the world textures were WebGL-incomplete and
sampled **black** (the 2D HUD used non-mipmapped textures, which is why it worked).
Fix (`src/rendererGLES/tr_image.c`, patch 09): call `glGenerateMipmap()` explicitly
after the level-0 upload. Textures are already scaled to power-of-two, so it's valid.

**Collision (was: fall through the world).** A stray write during renderer
world-load overwrites collision memory with drawVert floats (a corrupt
`cm.leafs[].cluster` reads back as the bits of ~0.375). The array that actually
broke traces was **`cm.planes`** (traces returned frac=1.0 through the floor), which
the old leafs-only snapshot never touched. Fix (`src/qcommon/cm_load.c`, patch 06):
back up ALL trace-critical arrays (planes/brushsides/brushes/nodes/leafs/leafbrushes/
leafsurfaces, map portion only) after load and restore any a cheap sampled checksum
shows corrupt, at the top of every trace. The real wild write is still unfixed
(needs a wasm watchpoint) — this is a robust workaround.

## What already works (do not re-do)

- **Toolchain + build**: Emscripten cross-compile of the engine to wasm; mods
  (cgame/ui/qagame) built as `SIDE_MODULE` `.wasm`, `dlopen`'d by the
  `MAIN_MODULE` engine. `emscripten_configure.ps1` then `emscripten_build.ps1`.
- **Boots & renders 2D**: SDL2 + WebGL, menus, profile creation, server browser
  (populated from the real master server via the bridge).
- **Networking**: `src/sys/net_emscripten.c` tunnels the UDP netchan over a
  WebSocket to the Go server (`bridge/main.go`, `/ws`). Master query, challenge→connect→
  gamestate handshake, live snapshots all work.
- **UDP pk3 download over the bridge** (fixed): `cl_wwwDownload 0` forces the
  windowed UDP download, which now completes over the relay (was stalling). Note
  it's slow (~25 KB/s, server-rate-capped). For big paks, prefer the fast
  side-load trick below.
- **Collision** (root-caused + worked around): the "OOB / fall-through-the-world"
  bug is a **stray write that overwrites `cm.leafs` with drawVert float data
  during client init** (renderer world load). Its symptoms cascaded into a fatal
  `CM_AreasConnected: area >= cm.numAreas` server crash. Fixes in place:
  - `src/qcommon/cm_test.c`: `CM_AreasConnected` / `CM_AdjustAreaPortalState`
    made non-fatal under `__EMSCRIPTEN__` (return instead of `Com_Error`).
  - `src/qcommon/cm_load.c` + `cm_trace.c` + `cm_local.h`:
    `CM_EMS_BackupLeafs()` snapshots `cm.leafs` right after load;
    `CM_EMS_RestoreLeafsIfCorrupt()` (canary-gated) restores it at the top of
    `CM_Trace` / `CM_PointContents`. This makes physical collision work (verified:
    player stands on ground, `viewpos` Z stable ~-174 on oasis instead of
    freefalling to Z=-millions).
  - **The real root cause (the stray writer) is still unfixed** — the
    backup/restore is a workaround. It may share a cause with the black-3D
    renderer bug (both involve drawVert/GL client arrays). Fixing the renderer
    might make the corruption disappear; if so, the workaround can be removed.

## Driving the game programmatically (important tooling we added)

The browser has no way to reach the command buffer of a running instance, and
pointer-lock can't be synthesized. Two mechanisms were added:

1. **JS→engine command hook** — `ETL_ExecCommand` (in `src/qcommon/common.c`,
   `EMSCRIPTEN_KEEPALIVE`). From the page:
   `Module.ccall('ETL_ExecCommand','null',['string'],['<console command>'])`.
   Use it for `connect`, `team r`, `class s 3 3`, `+forward`/`-forward`,
   `+moveup` (jump), `+attack` (fire), `viewpos`, etc. Runs on the next
   `Cbuf_Execute`. `HEAP32/HEAPF32/HEAPU8` are also exported for memory
   inspection (see `EXPORTED_RUNTIME_METHODS` in `cmake/ETLEmscripten.cmake`).
2. **Synthetic keyboard events DO reach SDL2** — dispatch
   `new KeyboardEvent('keydown'/'keyup', {code,key,keyCode,which,bubbles:true})`
   to the canvas/document. Verified: opened the console with a synthetic
   backquote, closed limbo with synthetic Escape. (Synthetic MOUSE / pointer-lock
   does **not** work — drive turning/looking with `+left`/`+right`/`+lookup`/
   `+lookdown` via the command hook instead.)

Verified in-game actions (local devmap, after the collision fix): **fire**
(ammo 30→24), **move** (compass + `viewpos` change), **look**. Once 3D renders,
this is enough to fully demonstrate walk/jump/fire.

## Live-server / pure-server notes

- **Fast pak side-load** (much faster than UDP download): the browser can't
  fetch a server's HTTP mirror cross-origin (CORS), so download the required
  pk3s **server-side** with `curl` into `etlegacy/build-wasm/dlpaks/{legacy,etmain}/`
  (served same-origin), then inject into the running client's FS and connect
  without a page reload:
  ```js
  // per pak: fetch same-origin, write to /etlhome/{legacy|etmain}/<name>.pk3
  const b = new Uint8Array(await (await fetch('/dlpaks/legacy/z_tot16.pk3')).arrayBuffer());
  Module.FS.writeFile('/etlhome/legacy/z_tot16.pk3', b);
  // then: Module.ccall('ETL_ExecCommand','null',['string'],['connect <ip:port>'])
  ```
  A `connect` triggers `FS_ConditionalRestart` which re-scans and picks up the
  injected paks. (Page reload loses MEMFS/IDBFS-injected paks reliably, so inject
  then connect via the hook — no reload.)
- **Pure-server fix** (in place): `src/qcommon/files.c`
  `FS_ReferencedPakPureChecksums` — the browser client loads cgame/ui as loose
  wasm side-modules, so no pak was flagged `FS_CGAME_REF`/`FS_UI_REF` and the
  server rejected the leading `@` in the `cp` command
  ("Unpure client detected. Invalid .PK3 files referenced!"). We now
  `FS_EMS_MarkModRef(...)` the real mod pak (contains `cgame.mp.x86_64.so` etc.)
  so the client reports the cgame/ui checksums the server expects. This got us
  **past** the pure check on a live server.
- **Heap size bumped to 2 GB** (`INITIAL_MEMORY=2147483648` in
  `cmake/ETLEmscripten.cmake`) so all of a server's custom paks + gameplay fit.
  Fixed size is fine — the WebGL "resizable ArrayBuffer" constraint is about
  `ALLOW_MEMORY_GROWTH`, not absolute size. Do NOT enable memory growth.

### The specific server the user asked about: `109.230.236.111:27960` (hirntot)

We got all the way through: connect → forced UDP/side-loaded its 5+ map paks →
**passed the pure check** → loaded cgame → then the server disconnected with
**"incompatible cgame"**. This is a **custom server-side check** (its Lua
`G_LuaHook_ClientConnect` / custom `ht260520_legacy` build), NOT a stock check —
our cgame passed the stock `CS_GAME_VERSION` match. **This server is effectively
un-joinable with a stock wasm cgame** (anti-tamper rejects non-matching clients).
To demonstrate the full remote gameplay flow, use a **stock ET: Legacy 2.84.x
server without custom anti-cheat** (our cgame is compatible there), or a local
`devmap`.

### Dev/test server for this round: `78.46.121.107:27961`

Use this address for connection/gameplay investigation — it's expected to be more
compatible (stock-ish 2.84.x, no aggressive anti-tamper) than the hirntot box, and
it pairs with the **v2.84.0 rebase** above (matching the client to the exact
release the server runs is the point of the rebase). Drive it via the JS hook:
`Module.ccall('ETL_ExecCommand','null',['string'],['connect 78.46.121.107:27961'])`
with the Go server running (`cd bridge && ./wolfasm-server`, serves ws + shell).

## Reconstructing the engine source (the port is shipped as a patch)

This repo does **not** contain the full ET: Legacy tree (it's a large fork with
submodules + signing keystores). Our port lives in `port/` (31 files: 26 modified
+ 5 new), now rebased onto the tagged release **ET: Legacy `v2.84.0`** (git commit
**`764ffc00a953e59aaf435272d004c49a89710309`**). We build against the exact tag on
purpose: live servers run 2.84.0, and matching it avoids client/server
version-mismatch connection problems. (It was previously cut against the dev
snapshot `b05dffd61` = `v2.84.0-18-gb05dffd`; the rebase needed only one trivial
context fix in `cmake/ETLPlatform.cmake`.)

The port lives in `port/patches/01..10-*.patch` — the change **split by concern**
(small, reviewable). Apply all ten in numeric order. There is intentionally **no
single combined patch**; maintain the split files only. See
`port/patches/README.md` for the file-by-file map.

To reconstruct a buildable tree:

```bash
git clone https://github.com/etlegacy/etlegacy.git
cd etlegacy
git checkout v2.84.0                          # == 764ffc0
git submodule update --init --recursive       # needs libs/ (minizip, cjson, sqlite3, ...)
for p in ../port/patches/[0-9]*.patch; do git apply "$p"; done
```

The port includes the `emscripten_*.ps1` build scripts (Windows) and the new
`cmake/ETLEmscripten.cmake`, `src/sys/net_emscripten.c`,
`src/sys/emscripten_gl_shim.c`. On **Linux** use `build-wasm.sh` at the repo root
(emsdk + ninja) instead of the `.ps1` scripts. After applying, follow
"Environment setup".

## Environment setup (for a fresh clone)

Not in git — obtain locally:
1. `emsdk/` — install Emscripten (6.x) at repo root, or point the scripts at your
   emsdk. The `.ps1` scripts source `emsdk/emsdk_env.ps1`.
   - **Patch the SDK**: apply `port/emsdk-patches/*` to `emsdk/upstream/emscripten`.
     `libglemu-addfunction-sig.patch` is **required** — without it the MAIN_MODULE
     build aborts at boot ("Missing signature argument to addFunction"). On Linux
     `./build-wasm.sh configure` (and `./build-wasm.sh patch-emsdk`) applies it
     idempotently; **re-run after any `emsdk install`/update** (it resets SDK files).
2. `assets/etmain/*.pk3` — retail ET paks from https://mirror.etlegacy.com/etmain/
   (+ legacy mod assets). Then package into the asset bundle:
   ```powershell
   python emsdk/upstream/emscripten/tools/file_packager.py `
     build-wasm/etl.data --preload assets@/etl --js-output=build-wasm/etl_data.js
   ```
   (and similarly `etl_mods.data` for the wasm mods + `ui/version_generated.h`).
3. Build: from `etlegacy/`, `./emscripten_configure.ps1` then
   `./emscripten_build.ps1` (or `./emscripten_build.ps1 etl` for just the engine).
   Editing `web/shell.html` does NOT retrigger a link — delete
   `build-wasm/etl.html` before rebuilding, or the shell won't update.
4. Run: `cd bridge && go build -o wolfasm-server . && WOLFASM_WEBROOT=../etlegacy/build-wasm ./wolfasm-server`
   then open `http://localhost:8080/` — the Go server serves the shell, the `/ws`
   relay (live servers) and the `/dl` download proxy on one port.

Windows / PowerShell: each `.ps1` rebuilds `$env:Path` from the registry and
sources `emsdk_env.ps1` with `$env:EMSDK_QUIET=1`.

## Debugging workflow that worked

- The dev preview (`mcp__Claude_Preview__*`) can run the server and `eval` JS in
  the page. `console.log`/`Com_Printf` output is mirrored to `window.__etlog`
  (see `web/shell.html` `print`/`printErr`) — read it via `preview_eval`.
- `preview_screenshot` for visuals; but screenshots can time out during
  continuous rendering — prefer reading `__etlog`, `viewpos`, and `readPixels`.
- Add temporary `Com_Printf("TAG ...")` diagnostics (they land in `__etlog`).
  Several `CMDIAG`/`CMDUMP`/`PURECHK` diagnostics were used and then removed;
  the pattern is in git history / earlier versions of `cm_trace.c`.

## Files changed for the port (grep `__EMSCRIPTEN__` / `EMSCRIPTEN` for all)

Key ones: `cmake/ETLEmscripten.cmake`, `cmake/ETLBuild{Client,Mod}.cmake`,
`src/sys/{net_emscripten.c,emscripten_gl_shim.c,sys_main.c}`,
`src/qcommon/{net_ip.c,common.c,files.c,cm_load.c,cm_trace.c,cm_test.c,cm_local.h,
vm.c,q_platform.h,q_shared.h}`,
`src/client/{cl_main.c,cl_parse.c,cl_scrn.c,cl_ui.c}`,
`src/{cgame,ui,game}/*_main.c` (17-arg `vmMain`), `web/shell.html`,
`bridge/main.go`.

## Priority order for next session

**Done (verified in-browser on Linux):**
- ✅ **Rebased onto ET: Legacy `v2.84.0` (`764ffc0`)** and **split the port into ten
  per-concern patches** (`port/patches/01..10`, no combined patch). All apply
  cleanly on a pristine `v2.84.0` checkout.
- ✅ **Full Linux build+debug toolchain** — no Windows needed. `emsdk` (6.0.2) +
  `.tools/bin/ninja` + `build-wasm.sh`; headless Chrome via WSLg is GPU-accelerated
  and gives screenshots + synthetic input (`debug/etl-drive.mjs`).
- ✅ **Textures fixed** — world renders fully textured with mipmaps
  (`glGenerateMipmap`, patch 09). See RESOLVED section.
- ✅ **Collision fixed** — player stands/walks, no fall-through (comprehensive
  `cm` array backup/restore, patch 06). See RESOLVED section.
- ✅ **Profile/settings persist** across reloads — `/etlhome` mounted as IDBFS +
  auto-seeded profile (no more first-run "enter a name"). `web/shell.html`.
- ✅ **Bridge-proxied pk3 downloads + per-origin cache** (patch 11 + bridge `/dl`
  endpoint) — pure-server paks fetched server-side (no libcurl/CORS), cached per
  origin, with UDP-over-bridge fallback when the server's www mirror lacks a pak.
- ✅ **Connected to the live server `78.46.121.107:27961`** (ET:L 2.83.2, pure):
  handshake → pure check → downloaded all 3 custom paks (legacy_v2.83.2 via proxy,
  ww2_etcamp + z_hdet via UDP fallback) → cgame loaded (2.84.0 cgame is compatible)
  → **receiving the live game snapshot stream** (real players/objectives). Verified
  in headless Chrome.

**Still open:**
1. In-game on the live server: join a team/class and spawn to first-person (as the
   local `devmap` flow does). UDP downloads of the mirror-missing paks are slow
   (~5KB/s, server rate-limited) on the FIRST connect; they then persist in IDBFS so
   subsequent connects are instant.
2. (Optional) Find the real stray-writer root cause (needs a wasm memory watchpoint;
   the corrupt data is drawVert floats landing in `cm.planes`/`cm.leafs`). Fixing it
   would let the collision backup/restore workaround be removed.
3. (Optional) Weapon viewmodel/some models still look dark on the D3D12 backend —
   worth checking model (vertex-lit) shading vs other GL backends.
